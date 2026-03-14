---
id: 9VeoQxxC
project: PizzaPi
topics:
    - subagent
    - configuration
    - performance
    - developer-experience
status: in
created: "2026-03-12T23:10:22-04:00"
updated: "2026-03-12T23:10:22-04:00"
---

Subagent concurrency is hardcoded: `MAX_PARALLEL_TASKS = 8` and `MAX_CONCURRENCY = 4` in `subagent.ts`. These should be configurable — different machines have very different capabilities, and users with fast API keys might want higher concurrency while users on rate-limited plans might want lower.

Could be a config option in `~/.pizzapi/config.json`:
```json
{
  "subagent": {
    "maxParallelTasks": 8,
    "maxConcurrency": 4
  }
}
```
