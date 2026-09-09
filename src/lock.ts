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
//   · a lock held past the end of a run by a leaked descendant (macOS: the lock drops when the
//     LAST inherited descriptor closes; Linux `flock -o` closes the fd before exec, so descendants
//     never inherit it). Hence the wait ceiling: a run that waits it out proceeds unlocked and
//     says so.

const DEFAULT_WAIT_S = 30 * 60;
const SENTINEL_POLL_MS = 250;
const DEFAULT_NAME = 'default';

export const LOCK_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Both `lockf -t` and `flock -w` reject values past their numeric range as a USAGE error, which
 * this wrapper would read as "could not acquire" and answer by running unserialized — every run,
 * from one oversized value. 2^31−1 is conservatively inside both utilities' ranges, and any number
 * up to it stringifies as plain decimal (no `1e+21` tokens). */
export const MAX_WAIT_S = 2147483647;

export interface RunLockedOptions {
  /** Lock name; distinct names are independent locks. Default `'default'`. */
  name?: string;
  /** Explicit lock file path, overriding name + directory derivation. */
  file?: string;
  /** Seconds to wait for a held lock before running unlocked. Default 1800. */
  waitS?: number;
  /** Environment to read configuration from (CPU_MUTEX*, CI, PATH). Default `process.env`. The
   * spawned command always inherits the real `process.env` regardless. */
  env?: NodeJS.ProcessEnv;
}

const note = (msg: string): void => {
  process.stderr.write(`[cpu-mutex] ${msg}\n`);
};

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

type HolderInfo = { pid?: number; startedAt?: string; cwd?: string };

const infoPath = (lock: string): string => `${lock}.info`;

const readInfo = (lock: string): HolderInfo | undefined =>
  quietly(() => JSON.parse(fs.readFileSync(infoPath(lock), 'utf8')) as HolderInfo);

const describeHolder = (lock: string): string => {
  const info = readInfo(lock);
  return info
    ? `held by pid ${info.pid} since ${info.startedAt} — ${info.cwd}`
    : 'holder not identified';
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

const trackGroup = (): { ref: { pid: number | null }; done: () => void } => {
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
  const lock = opts.file ?? lockFilePath(opts.name, env);

  const tracked = trackGroup();
  const group = tracked.ref;

  try {
    // Same process-group treatment as the locked path. Signalled by pid, a wrapper that had not
    // detached its child would exit and leave the run burning every core — and the unlocked paths
    // (CI, CPU_MUTEX=0, no utility, an unusable lock file) are where that is the DEFAULT state,
    // so leaving them undetached would put the orphan case where it is most likely, not least.
    const runDirectly = (): Promise<number> =>
      spawnAndWait(argv, { detached: true }, (child) => {
        group.pid = child.pid ?? null;
      });

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
      note(`if this never clears, see who holds the descriptor: lsof ${lock}`);
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
    const sentinel = `${lock}.started.${process.pid}`;
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

    return code;
  } finally {
    tracked.done();
  }
};
