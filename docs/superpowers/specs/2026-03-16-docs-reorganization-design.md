# Docs Reorganization & Expansion — Design Spec

## Problem

PizzaPi's documentation site (`packages/docs/`) has 14 guides dumped flat in a single `guides/` directory with no meaningful grouping. Key topics — MCP server setup, hooks, agent definitions — are either undocumented or buried inside unrelated pages. The sidebar uses `autogenerate`, so page ordering depends on frontmatter `order` values that don't reflect a coherent information architecture.

## Goals

1. **Reorganize** the sidebar into topic clusters with 3-level hierarchy (section → subsection → page).
2. **Fill gaps** with new dedicated pages: MCP Servers, Hooks, Agent Definitions.
3. **Expand** the Skills page with practical depth.
4. **Merge** Safe Mode content into the Sandbox page.
5. **Create a tutorial track** ("Start Here") that walks newcomers through setup linearly.
6. **Add AGENTS.md note**: `mcpServers{}` (Claude Code format) is always preferred.

## Audience

Experienced developers who already use Claude Code or similar AI coding tools. Newcomers are supported through the linear "Start Here" tutorial track but are not the primary audience.

## Non-Goals

- Documenting every internal implementation detail from source code.
- Building a separate tutorial site or interactive playground.
- Changing the docs framework (staying with Starlight/Astro).

---

## Site Structure

### Directory Layout

```
packages/docs/src/content/docs/
├── index.mdx                              (Overview — existing)
├── start-here/
│   ├── installation.mdx                   (from guides/installation.mdx)
│   ├── getting-started.mdx                (MERGE of guides/quick-setup.mdx + guides/getting-started.mdx)
│   └── first-remote-session.mdx           (NEW — relay setup walkthrough)
├── running/
│   ├── cli-reference.mdx                  (from guides/cli-reference.mdx)
│   ├── standalone-mode.mdx                (from guides/standalone-mode.mdx)
│   └── runner-daemon.mdx                  (from guides/runner-daemon.mdx)
├── deployment/
│   ├── self-hosting.mdx                   (from guides/self-hosting.mdx)
│   ├── tailscale.mdx                      (from guides/tailscale.mdx)
│   └── mac-setup.mdx                      (from guides/mac-setup.mdx)
├── customization/
│   ├── configuration.mdx                  (from guides/configuration.mdx — trimmed to overview)
│   ├── mcp-servers.mdx                    (NEW)
│   ├── hooks.mdx                          (NEW)
│   ├── skills.mdx                         (from guides/skills.mdx — expanded)
│   ├── agent-definitions.mdx              (NEW)
│   ├── claude-plugins.mdx                 (from guides/claude-plugins.mdx)
│   └── subagents.mdx                      (from guides/subagents.mdx)
├── security/
│   └── sandbox.mdx                        (MERGE of guides/sandbox.mdx + guides/safe-mode.mdx)
└── reference/
    ├── architecture.mdx                   (existing)
    ├── environment-variables.mdx          (existing)
    ├── api.mdx                            (existing)
    ├── development.mdx                    (from guides/development.mdx)
    └── windows-crashes.mdx                (existing)
```

### Sidebar Configuration

Replace `autogenerate` for guides with an explicit, manually-ordered sidebar in `astro.config.mjs`:

```js
sidebar: [
  {
    label: "Start Here",
    items: [
      { label: "Overview", slug: "index" },
      { label: "Installation", slug: "start-here/installation" },
      { label: "Getting Started", slug: "start-here/getting-started" },
      { label: "Your First Remote Session", slug: "start-here/first-remote-session" },
    ],
  },
  {
    label: "Running PizzaPi",
    items: [
      { label: "CLI Reference", slug: "running/cli-reference" },
      { label: "Standalone Mode", slug: "running/standalone-mode" },
      { label: "Runner Daemon", slug: "running/runner-daemon" },
    ],
  },
  {
    label: "Deployment",
    items: [
      { label: "Self-Hosting", slug: "deployment/self-hosting" },
      { label: "Tailscale HTTPS", slug: "deployment/tailscale" },
      { label: "macOS Service", slug: "deployment/mac-setup" },
    ],
  },
  {
    label: "Customization",
    items: [
      { label: "Configuration", slug: "customization/configuration" },
      { label: "MCP Servers", slug: "customization/mcp-servers" },
      { label: "Hooks", slug: "customization/hooks" },
      { label: "Skills", slug: "customization/skills" },
      { label: "Agent Definitions", slug: "customization/agent-definitions" },
      { label: "Claude Code Plugins", slug: "customization/claude-plugins" },
      { label: "Subagents", slug: "customization/subagents" },
    ],
  },
  {
    label: "Security",
    items: [
      { label: "Agent Sandbox", slug: "security/sandbox" },
    ],
  },
  {
    label: "Reference",
    autogenerate: { directory: "reference" },
  },
],
```

---

## New Pages

### 1. MCP Servers (`customization/mcp-servers.mdx`)

**Purpose:** Comprehensive guide to connecting MCP servers to PizzaPi.

**Sections:**

1. **What are MCP servers** — One-paragraph explainer. MCP servers provide additional tools (web search, databases, etc.) that the agent can use alongside built-in tools.

2. **Configuration** — Where to add server definitions:
   - `~/.pizzapi/config.json` (global) — available in all sessions
   - `.pizzapi/config.json` (project-local) — scoped to this repo
   - `mcpServers{}` format is **preferred** (Claude Code compatible)
   - `mcp.servers[]` array format also supported

3. **STDIO transport** — Step-by-step example:
   ```jsonc
   {
     "mcpServers": {
       "tavily": {
         "command": "npx",
         "args": ["-y", "@tavily/mcp-server"],
         "env": { "TAVILY_API_KEY": "tvly-..." }
       }
     }
   }
   ```
   Explain: command, args, env, cwd fields.

4. **HTTP / Streamable HTTP transport** — URL-based config:
   ```jsonc
   {
     "mcpServers": {
       "remote-tools": {
         "url": "https://mcp.example.com/sse",
         "transport": "sse"
       }
     }
   }
   ```
   Cover: `url`, `transport` (sse, streamable), headers, when to use each.

5. **OAuth for HTTP servers** — How PizzaPi handles OAuth flows for MCP servers that require authentication. Cover the OAuth provider, callback flow, and token storage.

6. **Managing servers at runtime** — `/mcp` slash command:
   - `/mcp` — show status of all connected servers
   - `/mcp disable <name>` — temporarily disable a server
   - `/mcp enable <name>` — re-enable a disabled server
   - `disabledMcpServers` config key for persistent disabling

7. **Troubleshooting** — Common issues:
   - Server timeout → `mcpTimeout` config key (default 30s)
   - Skip all MCP on startup → `PIZZAPI_NO_MCP=1`
   - Server not found → check config file path with `/mcp`

8. **Examples** — 2-3 real-world configs (Tavily search, filesystem server, custom tool server)

### 2. Hooks (`customization/hooks.mdx`)

**Purpose:** Guide to writing lifecycle hooks that intercept agent actions.

**Sections:**

1. **What are hooks** — Shell scripts or commands that run at specific points in the agent's lifecycle. They can observe, transform, or block agent actions.

2. **Where to define hooks** —
   - `~/.pizzapi/config.json` → `hooks` key (global, always active)
   - `.pizzapi/config.json` → `hooks` key (project-local, requires `allowProjectHooks: true` in global config)
   - Projects cannot self-authorize — trust gate is in global config only.

3. **Hook events** — Full table:

   | Event | When it fires | Can block? |
   |-------|--------------|------------|
   | `PreToolUse` | Before any tool call | Yes (exit 2) |
   | `PostToolUse` | After a tool completes | No |
   | `PostToolUseFailure` | After a tool errors | No |
   | `UserPromptSubmit` / `Input` | When user sends input | Yes (exit 2) |
   | `Stop` | When agent is about to stop | Can inject follow-up |
   | `SessionStart` | Session initialization | No |
   | `SessionEnd` | Session teardown | No |
   | `PreCompact` | Before context compaction | Yes (exit 2) |
   | `BeforeAgentStart` | Before agent turn begins | Can override system prompt |

4. **Writing a hook** — The I/O protocol:
   - Hook receives JSON on stdin (tool name, parameters, context)
   - Exit code 0 = allow, exit code 2 = block
   - Stdout JSON can include: `decision`, `reason`, `transformedPrompt`, `hookSpecificOutput.additionalContext`

5. **Config format** —
   ```jsonc
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash|Edit|Write",
           "hooks": [
             {
               "type": "command",
               "command": "~/.pizzapi/hooks/my-hook.sh",
               "timeout": 10
             }
           ]
         }
       ]
     }
   }
   ```

6. **Matchers** — Regex patterns filtering which tools trigger the hook:
   - `"Bash"` — only Bash tool
   - `"Edit|Write"` — Edit or Write
   - `".*"` or omitted — all tools

7. **Examples** — 3 practical hooks:
   - Lint-on-save: run ESLint after every Write/Edit
   - RTK token optimization: rewrite bash commands through RTK
   - Input guard: block certain patterns in user input

8. **Project hooks trust model** — Explain `allowProjectHooks` and why it exists (security).

### 3. Agent Definitions (`customization/agent-definitions.mdx`)

**Purpose:** How to create reusable agent definitions for the `subagent` tool.

**Sections:**

1. **What are agent definitions** — Markdown files that define specialized agents with scoped tools, custom instructions, and optional model overrides.

2. **File format** — Frontmatter fields:
   ```markdown
   ---
   name: researcher
   description: Read-only codebase research and analysis
   tools: read,grep,find,ls
   model: claude-sonnet-4-20250514
   ---
   You are a research agent. Read files, trace dependencies,
   and summarize findings without modifying anything.
   ```
   Cover all frontmatter fields: `name`, `description`, `tools`, `model`, `provider`.

3. **Discovery paths** — Where PizzaPi looks for agent definitions:
   - `~/.pizzapi/agents/` — global agents
   - `<cwd>/.pizzapi/agents/` — project-local agents
   - `~/.claude/agents/` — Claude Code compat path
   - Agent scope in subagent tool: `"user"` (default), `"project"`, `"both"`

4. **Tool restrictions** — How the `tools:` frontmatter limits what the agent can access. Explain: comma-separated tool names, no tools = all tools, MCP tools by prefixed name.

5. **Using agents** — Two ways:
   - `subagent` tool: inline execution, blocks until complete
   - `spawn_session`: background execution with triggers

6. **Built-in `task` agent** — Always available, no definition file needed. General-purpose delegation.

7. **Examples** — 3 practical agents:
   - `researcher.md` — read-only analysis
   - `refactorer.md` — code transformation with restricted tools
   - `reviewer.md` — code review agent

### 4. Skills Expansion (`customization/skills.mdx`)

**Additions to existing page:**

1. **SKILL.md frontmatter** — Document the full frontmatter spec:
   ```markdown
   ---
   name: my-skill
   description: When to use this skill
   tools: read,bash,edit
   ---
   ```

2. **Skill matching** — How the agent decides which skills to load (description matching, manual invocation).

3. **Referencing files within skills** — `${CLAUDE_PLUGIN_ROOT}` for plugin skills, relative paths for standalone skills.

4. **Agent Skills standard** — Brief mention of [agentskills.io](https://agentskills.io) compatibility.

5. **More examples** — Real-world skill patterns beyond the current Next.js example.

---

## Merged Pages

### Getting Started (MERGE: quick-setup.mdx + getting-started.mdx)

The current site has two overlapping pages:
- `quick-setup.mdx` — "fastest verified path" end-to-end
- `getting-started.mdx` — similar content with different framing

Merge into a single **"Getting Started"** page that:
1. Installs PizzaPi
2. Runs a local session (standalone)
3. Explains what to do next (link to relay setup, customization)

### Sandbox (MERGE: sandbox.mdx + safe-mode.mdx)

Move Safe Mode content into the Sandbox page as a section:
- Sandbox modes (none, basic, full) — existing content
- Filesystem/network restrictions — existing content  
- **Safe Mode & Startup Diagnostics** — new section from safe-mode.mdx content
  - Skip flags (`PIZZAPI_NO_MCP`, `PIZZAPI_NO_PLUGINS`, etc.)
  - `mcpTimeout` tuning
  - `slowStartupWarning` config

---

## Your First Remote Session (NEW: `start-here/first-remote-session.mdx`)

A linear tutorial that walks through setting up the relay server:

1. Prerequisites (PizzaPi installed, Docker available)
2. Start the relay server (`pizza web`)
3. Run `pizza setup` to connect CLI to relay
4. Open the web UI and see your first streamed session
5. Next steps (runner daemon for headless sessions, deployment for remote access)

---

## Existing Pages — Changes

| Page | Changes |
|------|---------|
| `configuration.mdx` | Trim MCP content (now has its own page). Add cross-links to MCP, Hooks, Skills pages. Keep config.json reference table. |
| `claude-plugins.mdx` | Trim hooks section (now has its own page). Add cross-link: "For standalone hooks outside plugins, see the Hooks guide." |
| `subagents.mdx` | Trim agent definition section (now has its own page). Add cross-link: "For writing agent definitions, see Agent Definitions." |
| `index.mdx` | Update sidebar links and feature highlights to match new structure. |

---

## AGENTS.md Update

Add to project AGENTS.md under Development Notes or a new "Configuration Conventions" section:

> **MCP config format:** Always use the `mcpServers{}` format (Claude Code compatible) as the preferred format. The `mcp.servers[]` array format is supported but not preferred. Claude Code compatibility is always the priority.

---

## Implementation Notes

- **File moves** are the bulk of the work — content mostly stays the same, just relocated.
- **New pages** (MCP, Hooks, Agent Definitions) should be sourced from the codebase (`packages/cli/src/extensions/`) for accuracy.
- **Sidebar config** changes from `autogenerate` to explicit `items` arrays in `astro.config.mjs`.
- **No redirects needed** — old URLs are being abandoned (per user decision).
- **Build verification**: `cd packages/docs && bun run build` must pass after all changes.
- Use Starlight components (`Aside`, `Steps`, `Tabs`, `FileTree`, `Code`) consistently across new pages.
