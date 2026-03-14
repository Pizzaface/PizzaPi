---
id: L4cZY3DA
project: PizzaPi
topics:
    - security
    - plan-mode
    - sandbox
    - command-parsing
status: in
created: "2026-03-12T23:10:22-04:00"
updated: "2026-03-12T23:10:22-04:00"
---

Plan mode's destructive command detection is regex-based (`DESTRUCTIVE_CMD_PATTERNS` and `DESTRUCTIVE_FLAG_PATTERNS` in `plan-mode-toggle.ts`). This is inherently fragile — it can be bypassed with aliases, shell functions, subshells, env vars in commands, etc. 

Ideas for hardening:
- Parse commands with a proper shell AST parser instead of regex
- Allowlist approach instead of blocklist (only permit known-safe commands)
- Sandbox via OS-level controls (seccomp, macOS sandbox-exec) as a defense-in-depth layer
- Run commands in a read-only filesystem namespace
