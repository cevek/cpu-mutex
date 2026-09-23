import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// One CPU-saturating command at a time on this machine. Several agents (or humans) work in
// parallel checkouts and share one CPU pool, so concurrent heavy runs — full test suites, builds —
// starve each other into timeout failures that carry no information about any diff.
//
// The mutex itself is the KERNEL's: `lockf` (macOS/BSD) or `flock` (Linux) hold an advisory lock
// on a file DESCRIPTOR, released by the kernel when the holder ends however it ends — SIGKILL and
// crashes included. That is what removes the entire stale-lock problem (heartbeats, liveness
// probes, age ceilings, steal protocols) rather than solving it. `lockf -k` is not optional:
// without it `lockf` DELETES the lock file on exit while the lock lives on the inode, so a delete +
// recreate hands two processes locks on different inodes and mutual exclusion breaks silently.
//
// What it does NOT close:
//   · a foreign CPU consumer. A resident daemon never takes this mutex, so a single uncontended
//     run can still starve under one.
//   · a neighbouring project serializing through its OWN mechanism. In particular, a
//     lock-by-file-EXISTENCE scheme pointed at this lock's path would not merge the two: its
//     stale-steal would unlink our inode and let two of OUR runs proceed. Sharing requires both
//     sides on this one mechanism — which is what this package is for.
//   · a descendant that left the run's process group (`setsid`). The lock lives exactly as long as
//     the utility process — the command never holds the descriptor (macOS `lockf` keeps it
//     close-on-exec, Linux `flock -o` closes it before exec) — so the group kill is the only thing
//     tying the command's life to the lock, and an escaped descendant runs on outside it.
//   · a holder that is alive but wedged. It keeps the lock for as long as it lives; the wait
//     ceiling bounds the queue behind it, the opt-in run ceiling bounds the holder itself.

const DEFAULT_WAIT_S = 30 * 60;
const SENTINEL_POLL_MS = 250;
const DEFAULT_NAME = 'default';

export const LOCK_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Both `lockf -t` and `flock -w` reject values past their numeric range as a USAGE error, which
 * this wrapper would read as "could not acquire" and answer by running unserialized — every run,
 * from one oversized value. 2^31−1 is conservatively inside both utilities' ranges, and any number
 * up to it stringifies as plain decimal (no `1e+21` tokens). */
export const MAX_WAIT_S = 2147483647;

/** Node's `setTimeout` caps at 2^31−1 MILLIseconds and fires after 1 ms past it, so a larger run
 * ceiling would kill every run at once. `MAX_WAIT_S` is the lock utilities' range, not this one. */
export const MAX_TIMEOUT_S = 2147483;

// The run ceiling exists for wedged processes, and a wedged process is exactly the one that does
// not react to a polite signal.
const KILL_GRACE_MS = 5_000;
const GROUP_POLL_MS = 100;

export interface RunLockedOptions {
  /** Lock name; distinct names are independent locks. Default `'default'`. */
  name?: string;
  /** Explicit lock file path, overriding name + directory derivation. */
  file?: string;
  /** Seconds to wait for a held lock before running unlocked. Default 1800. */
  waitS?: number;
  /** Seconds the command may run, counted from its actual start (queue time excluded). On expiry
   * its whole process group gets SIGTERM, then SIGKILL after a grace; the run resolves to 124, or
   * 137 if SIGKILL was needed. Default: no ceiling. */
  timeoutS?: number;
  /** Environment to read configuration from (CPU_MUTEX*, CI, PATH). Default `process.env`. The
   * spawned command always inherits the real `process.env` regardless. */
  env?: NodeJS.ProcessEnv;
}

const note = (msg: string): void => {
  process.stderr.write(`[cpu-mutex] ${msg}\n`);
};

/** For paths echoed inside copy-pastable commands: the default lock dir on macOS contains a
 * space (`Application Support`), so an unquoted hint breaks exactly on the default setup. */
export const shQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

const quietly = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

// Machine-wide and OUTSIDE any repo: the point is that unrelated projects contend on the same
// path by default.
const stateDir = (env: NodeJS.ProcessEnv): string => {
  const dir = env['CPU_MUTEX_DIR'];
  if (dir) return dir;
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'cpu-mutex');
  }
  if (process.platform === 'win32') {
    return path.join(env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local'), 'cpu-mutex');
  }
  return path.join(env['XDG_STATE_HOME'] || path.join(home, '.local', 'state'), 'cpu-mutex');
};

export const lockFilePath = (
  name: string = DEFAULT_NAME,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  // Enforced here, at the single owner of the derivation: every other check upstream can be
  // bypassed by calling this export directly, and a name like '../x' would silently escape the
  // state dir.
  if (!LOCK_NAME_RE.test(name)) {
    throw new TypeError(`lock name must match ${LOCK_NAME_RE}, got ${JSON.stringify(name)}`);
  }
  return env['CPU_MUTEX_FILE'] || path.join(stateDir(env), `${name}.lock`);
};

// Validated on the TOKEN, not the number: what reaches the utility is `String(value)`, and both
// `lockf -t` and `flock -w` parse a plain decimal integer only. `2.5` or `1e21` pass every numeric
// predicate and still arrive as tokens the utility rejects — and a rejection reads as "could not
// acquire", which this wrapper answers by running UNSERIALIZED. One typo in an exported variable
// would silently switch the mutex off for every run afterwards. The MAX_WAIT_S cap closes the
// same hole from the other side: an in-range value both parses and stringifies plainly.
const isWaitToken = (raw: string): boolean =>
  /^\d+$/.test(raw) && Number(raw) > 0 && Number(raw) <= MAX_WAIT_S;

const waitSeconds = (env: NodeJS.ProcessEnv, explicit: number | undefined): number => {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit <= 0 || explicit > MAX_WAIT_S) {
      throw new TypeError(
        `waitS must be a positive integer of seconds ≤ ${MAX_WAIT_S}, got ${explicit}`,
      );
    }
    return explicit;
  }
  const raw = env['CPU_MUTEX_WAIT_S'];
  if (raw === undefined || raw === '') return DEFAULT_WAIT_S;
  if (isWaitToken(raw)) return Number(raw);
  note(`ignoring CPU_MUTEX_WAIT_S=${JSON.stringify(raw)} — using ${DEFAULT_WAIT_S}s`);
  return DEFAULT_WAIT_S;
};

const timeoutSeconds = (explicit: number | undefined): number | undefined => {
  if (explicit === undefined) return undefined;
  if (!Number.isInteger(explicit) || explicit <= 0 || explicit > MAX_TIMEOUT_S) {
    throw new TypeError(
      `timeoutS must be a positive integer of seconds ≤ ${MAX_TIMEOUT_S}, got ${explicit}`,
    );
  }
  return explicit;
};

const enabled = (env: NodeJS.ProcessEnv): boolean => {
  const flag = env['CPU_MUTEX'];
  if (flag === '0') return false;
  if (flag === '1') return true;
  // A typo'd value must not silently become "unset": under CI that flips the mutex off with no
  // trace of the user's intent to force it on.
  if (flag !== undefined && flag !== '') {
    note(`ignoring CPU_MUTEX=${JSON.stringify(flag)} — expected '0' or '1'`);
  }
  // CI: one runner, no contention, and a lock must never hang a job.
  return !env['CI'];
};

type LockBin = { bin: string; kind: 'lockf' | 'flock' };

const executable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The locking utility, as {bin, kind}. `CPU_MUTEX_BIN` wins so a test can point it at nothing and
 * exercise the unlocked path — a PATH manipulation would not, since a resolved absolute path
 * ignores it. */
const findLockBin = (env: NodeJS.ProcessEnv): LockBin | null => {
  const override = env['CPU_MUTEX_BIN'];
  const candidates = override ? [override] : ['lockf', 'flock'];
  for (const candidate of candidates) {
    const kind = path.basename(candidate).includes('flock') ? ('flock' as const) : ('lockf' as const);
    if (candidate.includes(path.sep)) {
      if (executable(candidate)) return { bin: candidate, kind };
      continue;
    }
    for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const full = path.join(dir, candidate);
      if (executable(full)) return { bin: full, kind };
    }
  }
  return null;
};

/** Proves the lock file's directory is usable BEFORE the utility is invoked. Without this, a
 * permission or read-only-filesystem failure would come back as the utility's own exit code, which
 * is indistinguishable by number from an exit code of the command being run. */
const preflight = (lock: string): boolean => {
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.closeSync(fs.openSync(lock, 'a'));
    return true;
  } catch (err) {
    note(`lock file unusable (${(err as NodeJS.ErrnoException)?.code ?? err})`);
    return false;
  }
};

/** Non-blocking probe with a NO-OP command, purely to decide whether to print a waiting notice. It
 * must be a no-op: running the real command here would make the probe's exit code and the run's
 * indistinguishable, which is the whole hazard this wrapper guards against. `flock -n`, not
 * `-w 0`: modern util-linux special-cases a zero timeout as non-blocking, but older versions read
 * it as "no timeout" and would block. */
const isBusy = ({ bin, kind }: LockBin, lock: string): boolean => {
  const args = kind === 'flock' ? ['-n', lock, 'true'] : ['-k', '-t', '0', lock, 'true'];
  return spawnSync(bin, args, { stdio: 'ignore' }).status !== 0;
};

export type HolderInfo = { pid?: number; startedAt?: string; cwd?: string; cmd?: string };

const infoPath = (lock: string): string => `${lock}.info`;

const readInfo = (lock: string): HolderInfo | undefined =>
  quietly(() => JSON.parse(fs.readFileSync(infoPath(lock), 'utf8')) as HolderInfo);

const describeHolder = (lock: string): string => {
  const info = readInfo(lock);
  return info
    ? `held by pid ${info.pid} since ${info.startedAt} — ${info.cwd}`
    : 'holder not identified';
};

export interface LockStatusOptions {
  /** Lock name; distinct names are independent locks. Default `'default'`. */
  name?: string;
  /** Explicit lock file path, overriding name + directory derivation. */
  file?: string;
  /** Environment to read configuration from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface LockStatus {
  file: string;
  /** `true` = held, `false` = free, `null` = cannot tell (no locking utility). */
  busy: boolean | null;
  /** The advisory sidecar record, present only when it matches what `busy` says: a crashed
   * holder's kernel lock is gone while its record lingers, and reporting that record next to
   * "free" would name a holder that no longer exists. */
  holder?: HolderInfo;
}

/** Answers "who holds the mutex right now" without taking it. The truth about held/free is the
 * KERNEL's, via the same non-blocking no-op probe the waiting notice uses — the sidecar alone
 * cannot be trusted for it. Never creates the lock file: a missing file is simply a free lock. */
export const lockStatus = (opts: LockStatusOptions = {}): LockStatus => {
  const env = opts.env ?? process.env;
  const file = opts.file ?? lockFilePath(opts.name, env);
  const holder = readInfo(file);
  if (!fs.existsSync(file)) return { file, busy: false };
  const found = findLockBin(env);
  if (!found) return { file, busy: null, ...(holder ? { holder } : {}) };
  const busy = isBusy(found, file);
  return { file, busy, ...(busy && holder ? { holder } : {}) };
};

/** Runs a command, resolving to its exit code. */
const spawnAndWait = (
  argv: string[],
  opts: SpawnOptions,
  onSpawn?: (child: ChildProcess) => void,
): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', shell: false, ...opts });
    onSpawn?.(child);
    child.on('error', (err) => {
      note(`failed to start: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) =>
      resolve(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1)),
    );
  });

// One registry for every live run in this process, killed by ONE handler: process.exit inside the
// first handler would keep later-registered listeners from ever running, so per-call handlers
// would orphan every group but the first when concurrent runLocked calls receive a signal.
//
// The group-kill itself: each command is in its own process group, so a signal aimed at this
// process by pid does not reach it. Take the groups down BEFORE we stop holding the locks: a run
// that outlives its holder keeps burning every core with the mutex already free — exactly the
// parallel run this exists to prevent, happening silently. (Measured on `lockf` itself: SIGKILL
// frees the lock and leaves the command running.)
const liveGroups = new Set<{ pid: number | null }>();
let runSeq = 0;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;
const signalHandlers = SIGNALS.map(
  (sig) =>
    [
      sig,
      (): void => {
        for (const group of liveGroups) {
          if (group.pid !== null) quietly(() => process.kill(-group.pid!, sig));
        }
        process.exit(128 + (os.constants.signals[sig] ?? 0));
      },
    ] as const,
);

const groupGone = async (pgid: number, withinMs: number): Promise<boolean> => {
  const until = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
  }
};

const trackGroup =(): { ref: { pid: number | null }; done: () => void } => {
  const ref: { pid: number | null } = { pid: null };
  if (liveGroups.size === 0) {
    for (const [sig, handler] of signalHandlers) process.on(sig, handler);
  }
  liveGroups.add(ref);
  return {
    ref,
    done: (): void => {
      liveGroups.delete(ref);
      if (liveGroups.size === 0) {
        for (const [sig, handler] of signalHandlers) process.off(sig, handler);
      }
    },
  };
};

/** Runs `argv` under the machine-wide lock and resolves to its exit code. On
 * SIGINT/SIGTERM/SIGHUP/SIGQUIT it kills every live command's process group and exits the current
 * process — the run must not outlive its holder. */
export const runLocked = async (argv: string[], opts: RunLockedOptions = {}): Promise<number> => {
  if (argv.length === 0) throw new TypeError('runLocked needs a command');
  const env = opts.env ?? process.env;
  const waitS = waitSeconds(env, opts.waitS);
  const timeoutS = timeoutSeconds(opts.timeoutS);
  const lock = opts.file ?? lockFilePath(opts.name, env);

  const tracked = trackGroup();
  const group = tracked.ref;

  let deadline: NodeJS.Timeout | null = null;
  let escalation: NodeJS.Timeout | null = null;
  let timedOut = false;
  let killed = false;
  const startClock = (): void => {
    if (timeoutS === undefined || deadline !== null) return;
    deadline = setTimeout(() => {
      timedOut = true;
      note(`exceeded the run ceiling (--timeout ${timeoutS}s) — killing the run`);
      if (group.pid !== null) quietly(() => process.kill(-group.pid!, 'SIGTERM'));
      // Armed here, not after the spawned child closes: on the unlocked paths that child IS the
      // command, and a command ignoring SIGTERM never closes.
      escalation = setTimeout(() => {
        // The group may have emptied between the last poll and now; SIGKILL to nothing is not an
        // escalation.
        if (group.pid === null) return;
        killed = quietly(() => process.kill(-group.pid!, 'SIGKILL')) ?? false;
        if (killed) note(`the run ignored SIGTERM for ${KILL_GRACE_MS / 1000}s — sent SIGKILL`);
      }, KILL_GRACE_MS);
    }, timeoutS * 1000);
  };

  // The child we spawned closing is not the run ending: on the locked path it is the lock utility,
  // which dies on SIGTERM at once — freeing the lock — while a SIGTERM-ignoring command in the same
  // group lives on. Resolving there would leave the wedged run burning every core with the mutex
  // already free, so the verdict waits until the group is empty (bounded: past SIGKILL, only an
  // uninterruptible sleep can keep a member alive).
  const settle = async (code: number): Promise<number> => {
    if (deadline !== null) clearTimeout(deadline);
    if (!timedOut || group.pid === null) return code;
    if (!(await groupGone(group.pid, 2 * KILL_GRACE_MS))) {
      note(`the run's process group ${group.pid} is still alive after SIGKILL`);
    }
    if (escalation !== null) clearTimeout(escalation);
    return killed ? 137 : 124;
  };

  try {
    // Same process-group treatment as the locked path. Signalled by pid, a wrapper that had not
    // detached its child would exit and leave the run burning every core — and the unlocked paths
    // (CI, CPU_MUTEX=0, no utility, an unusable lock file) are where that is the DEFAULT state,
    // so leaving them undetached would put the orphan case where it is most likely, not least.
    const runDirectly = async (): Promise<number> =>
      settle(
        await spawnAndWait(argv, { detached: true }, (child) => {
          group.pid = child.pid ?? null;
          startClock();
        }),
      );

    const unlocked = (reason: string): Promise<number> => {
      note(`${reason} — running WITHOUT the lock (runs are not serialized)`);
      return runDirectly();
    };

    if (!enabled(env)) {
      note(env['CPU_MUTEX'] === '0' ? 'disabled (CPU_MUTEX=0)' : 'disabled under CI');
      return await runDirectly();
    }

    const found = findLockBin(env);
    if (!found) return await unlocked('no lockf/flock on this system');

    if (!preflight(lock)) return await unlocked('lock file directory not writable');

    if (isBusy(found, lock)) {
      note(`waiting for the lock — ${describeHolder(lock)}`);
      note(`if this never clears, see who holds the descriptor: lsof ${shQuote(lock)}`);
    }

    // The sentinel is written by the inner shell immediately BEFORE the real command runs, so its
    // presence separates "the command ran and failed" from "the locking utility itself failed".
    // Without it a non-zero exit is ambiguous — and reading a utility failure as a red run (or the
    // reverse) is the one mistake that turns this wrapper into a liar about the gate.
    //
    // No `exec`, and the trailing `exit $?` is load-bearing: it keeps sh from tail-exec'ing the
    // command (dash replaces itself for the last command of a `-c` script), so sh stays the parent
    // and itself maps a signal-killed command to 128+n — `lockf` reports a signal-killed child as
    // EX_SOFTWARE (70), losing WHICH signal on exactly the OOM/segfault runs that need it. The
    // `|| exit 66` is for bash-as-sh: POSIX says a redirection failure on `:` exits the shell, but
    // bash carries on — the command would run with no sentinel written, and its red exit would
    // read as a utility failure and re-run the whole thing unlocked, a second time.
    // Per CALL, not per process: concurrent runLocked calls on one lock would otherwise read each
    // other's sentinel — a queued call would start its run clock, and count as having run.
    const sentinel = `${lock}.started.${process.pid}.${++runSeq}`;
    quietly(() => fs.rmSync(sentinel, { force: true }));
    const inner = ['sh', '-c', ': > "$1" || exit 66; shift; "$@"; exit $?', 'cpu-mutex', sentinel, ...argv];
    const lockArgs =
      found.kind === 'flock'
        ? ['-o', '-w', String(waitS), lock, ...inner]
        : ['-k', '-t', String(waitS), lock, ...inner];

    let utilityPid: number | undefined;
    let watcher: NodeJS.Timeout | null = null;
    const code = await spawnAndWait([found.bin, ...lockArgs], { detached: true }, (child) => {
      group.pid = child.pid ?? null;
      utilityPid = child.pid;
      // Advisory only — nothing about mutual exclusion reads this, so a missing or stale sidecar
      // costs a less informative waiting line and nothing else.
      watcher = setInterval(() => {
        if (!fs.existsSync(sentinel)) return;
        if (watcher !== null) clearInterval(watcher);
        watcher = null;
        startClock();
        quietly(() =>
          fs.writeFileSync(
            infoPath(lock),
            JSON.stringify({
              pid: child.pid,
              startedAt: new Date().toISOString(),
              cwd: process.cwd(),
              cmd: argv.join(' '),
            }),
          ),
        );
      }, SENTINEL_POLL_MS);
    });
    if (watcher !== null) clearInterval(watcher);
    const settled = await settle(code);

    const ran = fs.existsSync(sentinel);
    quietly(() => fs.rmSync(sentinel, { force: true }));
    // Only our own sidecar, and only if we were the holder. A run that gave up waiting never owned
    // it, and by cleanup time the NEXT holder may already have written ITS record — deleting that
    // would blind the next waiter's notice about a holder that is still very much there.
    if (ran && readInfo(lock)?.pid === utilityPid) {
      quietly(() => fs.rmSync(infoPath(lock), { force: true }));
    }

    // Never reached the command: the utility could not take the lock (the wait ceiling ran out, or
    // a failure the preflight could not see). Report and run anyway — an unserialized run that says
    // so beats a gate that hangs, and beats a red result nobody can attribute.
    if (!ran && code !== 0) {
      return await unlocked(`could not acquire the lock (${found.bin} exit ${code})`);
    }

    return settled;
  } finally {
    if (deadline !== null) clearTimeout(deadline);
    if (escalation !== null) clearTimeout(escalation);
    tracked.done();
  }
};
