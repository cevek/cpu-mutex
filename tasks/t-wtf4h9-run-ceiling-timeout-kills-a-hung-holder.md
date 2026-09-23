---
id: t-wtf4h9
title: "Run ceiling: --timeout kills a hung holder's whole group"
status: done
priority: high
author: 9c9143b5
assignee: 9c9143b5
created: '2026-09-23T14:39:44.597Z'
---
A hung holder (live case downstream: `tsgo` crashed in the Go runtime and sat 43 minutes in state R holding the lock) is bounded by nothing: `--wait` bounds only the WAITERS, and the stuck process burns a core until a human notices. External `timeout(1)`/`gtimeout` is not an answer: absent on stock macOS, and it signals only its direct child (`npm run` → `sh` → `tsgo` survives), and it would count queue time against the budget.

## Plan

- `runLocked` option `timeoutS` + CLI `--timeout <seconds>`: opt-in, NO default (any default eventually kills a legitimate long build), NO env var (the wait ceiling is a property of the machine queue, the run ceiling is a property of one command — one `CPU_MUTEX_*` number from a shell profile would land on commands of very different lengths).
- Bound `MAX_TIMEOUT_S = 2_147_483`: Node `setTimeout` caps at 2^31−1 ms and fires after 1 ms past it — `MAX_WAIT_S` is the lock utilities' range and does not apply. Validated in `runLocked` (TypeError) and in the CLI (usage error); `--status` rejects `--timeout`.
- Clock starts when the command actually starts: on the locked path when the sentinel appears (the existing 250 ms watcher in `runLocked`), on the unlocked paths at spawn. Queue time never counts.
- On expiry: SIGTERM to the process group, then do NOT resolve until the group is empty — the lock utility dies first and frees the lock while a SIGTERM-ignoring command lives on, the exact hazard the group kill exists for. After a 5 s grace with members left: SIGKILL to the group, wait for it to empty.
- Exit codes (GNU `timeout` convention): 124 when SIGTERM sufficed, 137 when SIGKILL was needed; a stderr line names the timeout either way, so a command's own 124 stays distinguishable.
- Known limit: a descendant that left the group (`setsid`) survives the kill.
- Accepted: a SIGINT/SIGTERM to the wrapper during the grace takes the existing signal path (group gets that signal, wrapper exits) and skips the SIGKILL escalation.
- Tests (`test/timeout.test.ts`, via the real CLI): SIGTERM-ignoring command on both locked and unlocked paths → 137 and the command's pid is dead the moment the wrapper exits; well-behaved command → 124, lock free; wait time is not counted; fast command's own code passes through; validation.
- README: Behavior + CLI sections.
