---
id: t-2qe1rd
title: 'Waiting line: queue position and ETA; a light lock for short probes'
status: backlog
priority: medium
author: e0d84e99
created: '2026-10-06T11:50:13.489Z'
---
Reported from artbord (t-yf1q6m): other projects' long runs (gradle, 10–30+ min) hold the machine lock, and probes and gates wait in the queue for hours. The waiting line names the holder only.

Wanted:
- the waiter's position in the queue and an ETA (e.g. from the holder's elapsed time and past run lengths of the same command) in the waiting line, refreshed while waiting;
- a lighter lock (a named lock, or a mode) for short probes, so a 10-second check does not queue behind a 30-minute suite.

The wait ceiling itself is loud already (`running WITHOUT the lock`); a caller's script that waits for its command's output only sees the run start late.
