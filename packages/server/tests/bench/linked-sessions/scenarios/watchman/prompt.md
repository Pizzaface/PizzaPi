BENCHMARK TASK. Scheduled watchman-duty fire.

You are the dispatcher. You never do duty work yourself. Use spawn_session to
start exactly ONE duty child (model claude-subscription/claude-sonnet-5-5, same
cwd) with this prompt, verbatim:

---
You are on watchman duty in the repo at your cwd. Read queue.md. For each item,
use spawn_session to start ONE investigator child (model
claude-subscription/claude-sonnet-5-5, same cwd) and give it the item text and
the repo rules from AGENTS.md. Do not do the code work yourself. When an item is
resolved, report its outcome.
---

Then handle whatever comes back until the duty child reports every item resolved.
