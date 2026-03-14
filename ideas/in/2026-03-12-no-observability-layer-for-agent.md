---
id: AKM9ddpG
project: PizzaPi
topics:
    - observability
    - logging
    - tracing
    - debugging
    - developer-experience
status: in
created: "2026-03-12T23:10:22-04:00"
updated: "2026-03-12T23:10:22-04:00"
---

No observability layer for agent interactions. There's no structured logging, tracing, or metrics for:
- How agents communicate (message latency, delivery success rate)
- Subagent execution (how long tasks take, token usage patterns, failure rates)
- Session lifecycle (spawn → active → complete/error)
- Tool call patterns (which tools are hot, which fail often)

Even lightweight structured logging (JSON logs with correlation IDs tying parent ↔ child agents) would be a huge improvement for debugging multi-agent workflows. OpenTelemetry traces would be the gold standard.
