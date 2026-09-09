# cpu-mutex

Machine-wide mutex for heavy commands — one CPU-saturating run at a time across **every project on
the machine**.

Built for fleets of AI agents (or humans) working in parallel checkouts that share one CPU pool:
concurrent full test suites and builds starve each other into timeout failures that carry no
information about any diff. Wrap the heavy commands and they queue instead.

```jsonc
// package.json — in every project on the machine
{
  "scripts": {
    "test": "cpu-mutex -- vitest run",
    "build:full": "cpu-mutex -- turbo build"
  }
}
```

The default lock file lives **outside any repo** (`~/Library/Application Support/cpu-mutex/` on
macOS, `$XDG_STATE_HOME/cpu-mutex/` or `~/.local/state/cpu-mutex/` on Linux,
`%LOCALAPPDATA%\cpu-mutex\` on Windows), so unrelated projects contend on the same lock out of the
box — that is the feature.

## Why a kernel lock

The mutex is the kernel's own: `lockf` (macOS/BSD) or `flock` (util-linux) hold an advisory lock on
a file **descriptor**, which the kernel releases when the holder ends — however it ends, SIGKILL
and crashes included. That *removes* the entire stale-lock problem (heartbeats, liveness probes,
age ceilings, steal protocols) rather than solving it. There is no lock to clean up, ever.

Zero runtime dependencies; both utilities ship with their OS.

## Behavior

- **A blocked run waits and says so** on stderr: who holds the lock (pid, start time, cwd) and how
  to inspect it (`lsof <lockfile>`). Waiting is normal, not a hang.
- **Waiting is bounded** (`--wait` / `CPU_MUTEX_WAIT_S`, default 30 min). Past the ceiling the run
  proceeds **unserialized** and prints `running WITHOUT the lock` — that line always means the run
  is unprotected, never that things worked quietly.
- **Exit codes pass through untouched.** A red run is reported red exactly once — a startup
  sentinel distinguishes "the command ran and failed" from "the locking utility failed", so a
  utility failure never silently re-runs your suite.
- **Signals kill the whole run.** The command runs in its own process group;
  SIGINT/SIGTERM/SIGHUP/SIGQUIT to the wrapper take the group down before the lock is released.
  Without this, killing the wrapper would free the lock while the command keeps burning every
  core — the exact parallel run the mutex exists to prevent.
- **CI is off by default** (any non-empty `CI`): one runner, no contention, and a lock must never
  hang a job. `CPU_MUTEX=1` overrides.
- **Degradation is loud, never silent**: no utility on the system, an unwritable lock directory, or
  an exhausted wait all run the command unlocked and say so on stderr.
- **Junk configuration cannot disable the mutex.** An invalid `CPU_MUTEX_WAIT_S` (a typo, `2.5`,
  `1e21`, a value past 2^31−1) is ignored with a notice and the default is used — validated on the
  token, because the utility would reject the string and the rejection would otherwise read as
  "could not acquire". An unrecognized `CPU_MUTEX` value (`true`, `yes`) is likewise reported
  before falling back to the default behavior.

## CLI

```
cpu-mutex [--name <lock>] [--wait <seconds>] -- <command> [args...]
cpu-mutex --status [--name <lock>]
```

- `--name <lock>` — a separate named lock (`[A-Za-z0-9._-]+`). Distinct names never contend; use
  them to serialize different resource classes independently. Default: `default`.
- `--wait <seconds>` — wait ceiling before running unlocked (positive integer, max 2^31−1).
- `--status` — who holds the mutex right now, without taking it:

  ```
  $ cpu-mutex --status
  ~/Library/Application Support/cpu-mutex/default.lock: held by pid 4321 since 2026-09-09T11:02:07.311Z — /Users/me/proj (vitest run)
  ```

  The held/free verdict comes from the kernel (the same non-blocking probe a waiting run uses);
  the pid/cwd/command line is the holder's advisory sidecar and is only shown when the kernel
  agrees the lock is held. Scriptable exit codes: `0` free, `1` held, `2` usage error, `3` cannot
  tell (no locking utility). For the full picture including waiters: `lsof <lockfile>`.

The `--` may be omitted when the command does not itself start with a dash:
`cpu-mutex vitest run` works.

## Environment

| Variable           | Effect                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| `CPU_MUTEX=0`      | force off (beats everything)                                            |
| `CPU_MUTEX=1`      | force on (beats `CI`)                                                   |
| `CI` (non-empty)   | off by default                                                          |
| `CPU_MUTEX_WAIT_S` | wait ceiling in seconds (default 1800)                                  |
| `CPU_MUTEX_FILE`   | explicit lock file path (overrides `--name` and the state dir)          |
| `CPU_MUTEX_DIR`    | directory for named locks (default: the OS state dir, machine-wide)     |
| `CPU_MUTEX_BIN`    | the locking utility, overriding the `lockf`/`flock` PATH search         |

## Programmatic API

```ts
import { runLocked, lockFilePath } from 'cpu-mutex';

const code = await runLocked(['vitest', 'run'], { name: 'default', waitS: 900 });
process.exit(code);
```

`runLocked(argv, opts)` spawns the command under the lock and resolves to its exit code. Options:
`name` (named lock), `file` (explicit lock file, overrides derivation), `waitS` (wait ceiling —
invalid values throw a `TypeError`, unlike env values which fall back loudly), `env` (environment
to read `CPU_MUTEX*`/`CI`/`PATH` configuration from; the command itself always inherits the real
`process.env`).

On SIGINT/SIGTERM/SIGHUP/SIGQUIT it kills the process group of **every** live `runLocked` command
in the process (concurrent calls share one signal handler) and exits the process. If your
application must survive signals, wrap the call in a subprocess.

Also exported: `lockStatus({ name?, file?, env? })` — the `--status` answer as data
(`{ file, busy: boolean | null, holder? }`); `lockFilePath(name?, env?)` — the derived lock file
path (throws on an invalid name); `LOCK_NAME_RE`, `MAX_WAIT_S` — the validation bounds.

There is deliberately no `acquire()/release()` or `withLock(fn)` API: the lock's lifetime is tied
to a process holding a descriptor, which is exactly what makes it stale-proof.

## What it does NOT protect against

Honesty about scope, so the gaps are known rather than discovered:

- **Resident CPU consumers.** A daemon (language server, MCP server, watcher) never takes a mutex;
  a single uncontended run can still starve under one.
- **Projects serializing through their own mechanism.** A lock-by-file-existence scheme pointed at
  this lock's path would not merge the two mutexes — its stale-steal would unlink the inode this
  lock lives on and break mutual exclusion silently. Sharing requires both sides on this package
  (or at least on the same kernel primitive and path).
- **Leaked descendants.** On macOS the lock drops only when the last inherited descriptor closes,
  so a detached grandchild can hold it past the run (on Linux `flock -o` prevents inheritance).
  This is why the wait ceiling exists.
- **Windows.** No `lockf`/`flock` — runs execute unlocked, loudly.
