---
id: t-2ea67f
title: withLock(fn) programmatic API
status: backlog
priority: low
author: cd57d77a
created: '2026-09-09T10:58:27.263Z'
---
For heavy work done in-process rather than via a spawned command. Mechanism: spawn the utility around a descriptor-holding no-op child (e.g. sh reading stdin), poll the acquisition sentinel, release by closing stdin / killing the group. Deliberately left out of v1: the holder-child protocol adds fragile test surface. Decide demand first.
