---
id: t-v8wh12
title: 'Semaphore mode: N concurrent slots instead of a binary mutex'
status: backlog
priority: low
author: cd57d77a
created: '2026-09-09T10:58:27.489Z'
---
Allow up to N heavy runs concurrently (--slots N): N lock files <name>.<0..N-1>.lock, try each nonblocking, then poll-retry until the wait ceiling. Blocking-wait on ANY of N files is not expressible with lockf/flock alone, hence the retry loop. Only worth it on machines whose core count comfortably fits two suites.
