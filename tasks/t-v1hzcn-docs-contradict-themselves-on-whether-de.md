---
id: t-v1hzcn
title: Docs contradict themselves on whether descendants inherit the lock fd
status: done
priority: medium
author: 9c9143b5
created: '2026-09-23T14:39:44.809Z'
---
The docs disagree with each other on whether the command inherits the lock descriptor on macOS:

- `src/lock.ts` header, "What it does NOT close" → "a lock held past the end of a run by a leaked descendant (macOS: the lock drops when the LAST inherited descriptor closes…)", and README "Leaked descendants" say descendants keep the lock alive.
- the comment above `liveGroups` in `src/lock.ts` says "SIGKILL frees the lock and leaves the command running" — i.e. the command does NOT hold it.

A probe on macOS (`lockf -k -t 0 L sh -c '…'`, then `lsof L`) shows the descriptor only on `lockf` itself (FD_CLOEXEC): killing `lockf` frees the lock while the command lives. Verify on macOS and Linux (`flock -o`), then make the header, README and the wait-ceiling rationale state one measured truth.
