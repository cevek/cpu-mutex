---
id: t-mdtkxx
title: Add repository/bugs/homepage to package.json
status: backlog
priority: medium
author: cd57d77a
created: '2026-09-09T11:36:24.281Z'
---
0.1.0 went to npm without a repository field (the GitHub repo did not exist yet), so the npm page has no source link and provenance is unavailable. Once the GitHub remote exists: add repository/bugs/homepage, and let the fields reach npm with the next release — a version bump is required, package.json changes alone do not update a published version.
