---
id: EIBievZR
project: PizzaPi
topics:
    - plugins
    - ecosystem
    - developer-experience
    - marketplace
status: in
created: "2026-03-12T23:10:22-04:00"
updated: "2026-03-12T23:10:22-04:00"
---

The plugin system (Claude Code plugin adapter in `claude-plugins.ts`) supports commands, hooks, skills, agents, rules, and MCP — but there's no plugin marketplace or discovery mechanism. Users have to manually install plugins by cloning repos into the right directory.

Ideas:
- Plugin registry (like npm but for agent plugins) with `pizza plugin install <name>`
- Plugin templates / scaffolding: `pizza plugin create my-plugin`
- Plugin validation/linting to catch manifest issues before runtime
- Versioned plugin dependencies so plugins can depend on each other
