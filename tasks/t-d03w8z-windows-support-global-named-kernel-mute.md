---
id: t-d03w8z
title: 'Windows support: Global named kernel mutex via PowerShell'
status: backlog
priority: low
author: cd57d77a
created: '2026-09-09T11:09:51.325Z'
---
Windows has the exact primitive natively — a named kernel mutex (Global\cpu-mutex-<name>) with abandoned-mutex semantics: the kernel hands it to the next waiter when the holder dies however it dies. No stale locks by design, no lock file needed. Node cannot reach it without a native addon (fs exposes no share modes, no CreateMutex), which would break zero runtime deps.

Route that fits the existing architecture: PowerShell as a third utility kind next to lockf/flock. The ps script takes System.Threading.Mutex('Global\...'), WaitOne(<waitMs>) — catch AbandonedMutexException as SUCCESSFUL acquisition — writes the sentinel, starts the command, exits with its code. Slow powershell startup (~1s) is irrelevant for heavy commands.

Known traps: argument quoting (use -EncodedCommand or a temp .ps1, never string-spliced -Command); no POSIX process groups — kill the command tree via taskkill /pid <pid> /T; signal semantics differ (no SIGHUP; child.kill maps to TerminateProcess).

Gate: implement TOGETHER with a GitHub Actions windows runner exercising the suite — without CI this is a designed-but-unexercised branch, which this codebase refuses to carry. README 'Windows runs unlocked, loudly' stays until then.
