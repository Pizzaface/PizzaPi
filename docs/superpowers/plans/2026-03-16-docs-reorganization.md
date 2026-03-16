# Docs Reorganization & Expansion — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the PizzaPi docs site from a flat `guides/` dump into topic-clustered sections with 3-level hierarchy, and fill documentation gaps for MCP servers, hooks, and agent definitions.

**Architecture:** Move existing `.mdx` files into new subdirectories (`start-here/`, `running/`, `deployment/`, `customization/`, `security/`). Create 3 new pages and expand 1 existing page. Update `astro.config.mjs` sidebar from `autogenerate` to explicit manual ordering. Merge 2 pairs of overlapping pages.

**Tech Stack:** Starlight (Astro), MDX, Starlight components (`Aside`, `Steps`, `Tabs`, `FileTree`, `Code`)

**Spec:** `docs/superpowers/specs/2026-03-16-docs-reorganization-design.md`

---

## Chunk 1: Directory Structure & File Moves

Move existing pages from `guides/` into the new topic-cluster directories. No content changes — just file relocations and frontmatter cleanup (remove `sidebar.order` since we'll use explicit sidebar config).

**Base path:** `packages/docs/src/content/docs/`

### Task 1: Create new directory structure

**Files:**
- Create directories: `start-here/`, `running/`, `deployment/`, `customization/`, `security/`

- [ ] **Step 1: Create directories**

```bash
cd packages/docs/src/content/docs
mkdir -p start-here running deployment customization security
```

- [ ] **Step 2: Commit**

```bash
git add -A packages/docs/src/content/docs/
git commit -m "docs: create new topic-cluster directories"
```

### Task 2: Move "Start Here" pages

**Files:**
- Move: `guides/installation.mdx` → `start-here/installation.mdx`
- Move: `getting-started.mdx` → `start-here/getting-started.mdx`
- Delete: `guides/quick-setup.mdx` (will be merged into getting-started in Task 8)

- [ ] **Step 1: Move installation**

```bash
cd packages/docs/src/content/docs
mv guides/installation.mdx start-here/installation.mdx
```

- [ ] **Step 2: Move getting-started**

```bash
mv getting-started.mdx start-here/getting-started.mdx
```

- [ ] **Step 3: Remove sidebar.order from moved files' frontmatter**

Edit both files to remove `sidebar: order: N` blocks (no longer needed with explicit sidebar).

- [ ] **Step 4: Commit**

```bash
git add -A packages/docs/src/content/docs/
git commit -m "docs: move Start Here pages to start-here/"
```

### Task 3: Move "Running PizzaPi" pages

**Files:**
- Move: `guides/cli-reference.mdx` → `running/cli-reference.mdx`
- Move: `guides/standalone-mode.mdx` → `running/standalone-mode.mdx`
- Move: `guides/runner-daemon.mdx` → `running/runner-daemon.mdx`

- [ ] **Step 1: Move files**

```bash
cd packages/docs/src/content/docs
mv guides/cli-reference.mdx running/cli-reference.mdx
mv guides/standalone-mode.mdx running/standalone-mode.mdx
mv guides/runner-daemon.mdx running/runner-daemon.mdx
```

- [ ] **Step 2: Remove sidebar.order from frontmatter of all 3 files**

- [ ] **Step 3: Commit**

```bash
git add -A packages/docs/src/content/docs/
git commit -m "docs: move Running pages to running/"
```

### Task 4: Move "Deployment" pages

**Files:**
- Move: `guides/self-hosting.mdx` → `deployment/self-hosting.mdx`
- Move: `guides/tailscale.mdx` → `deployment/tailscale.mdx`
- Move: `guides/mac-setup.mdx` → `deployment/mac-setup.mdx`

- [ ] **Step 1: Move files**

```bash
cd packages/docs/src/content/docs
mv guides/self-hosting.mdx deployment/self-hosting.mdx
mv guides/tailscale.mdx deployment/tailscale.mdx
mv guides/mac-setup.mdx deployment/mac-setup.mdx
```

- [ ] **Step 2: Remove sidebar.order from frontmatter**

- [ ] **Step 3: Commit**

```bash
git add -A packages/docs/src/content/docs/
git commit -m "docs: move Deployment pages to deployment/"
```

### Task 5: Move "Customization" pages

**Files:**
- Move: `guides/configuration.mdx` → `customization/configuration.mdx`
- Move: `guides/skills.mdx` → `customization/skills.mdx`
- Move: `guides/claude-plugins.mdx` → `customization/claude-plugins.mdx`
- Move: `guides/subagents.mdx` → `customization/subagents.mdx`

- [ ] **Step 1: Move files**

```bash
cd packages/docs/src/content/docs
mv guides/configuration.mdx customization/configuration.mdx
mv guides/skills.mdx customization/skills.mdx
mv guides/claude-plugins.mdx customization/claude-plugins.mdx
mv guides/subagents.mdx customization/subagents.mdx
```

- [ ] **Step 2: Remove sidebar.order from frontmatter**

- [ ] **Step 3: Commit**

```bash
git add -A packages/docs/src/content/docs/
git commit -m "docs: move Customization pages to customization/"
```

### Task 6: Move "Security" and "Reference" pages

**Files:**
- Move: `guides/sandbox.mdx` → `security/sandbox.mdx`
- Move: `guides/safe-mode.mdx` → temporarily keep (will merge into sandbox in Task 9)
- Move: `guides/development.mdx` → `reference/development.mdx`

- [ ] **Step 1: Move sandbox**

```bash
cd packages/docs/src/content/docs
mv guides/sandbox.mdx security/sandbox.mdx
```

- [ ] **Step 2: Move development to reference**

```bash
mv guides/development.mdx reference/development.mdx
```

- [ ] **Step 3: Remove sidebar.order from frontmatter. Add `order: 5` to development.mdx for auto-sort in reference.**

- [ ] **Step 4: Delete empty guides/ directory (should only have safe-mode.mdx and quick-setup.mdx remaining)**

Verify: `ls guides/` should show only `safe-mode.mdx` and `quick-setup.mdx`.

- [ ] **Step 5: Commit**

```bash
git add -A packages/docs/src/content/docs/
git commit -m "docs: move Security and Reference pages"
```

### Task 7: Update sidebar config in astro.config.mjs

**Files:**
- Modify: `packages/docs/astro.config.mjs`

- [ ] **Step 1: Replace sidebar configuration**

Replace the existing `sidebar` array in `astro.config.mjs` with:

```js
sidebar: [
    {
        label: "Start Here",
        items: [
            { label: "Overview", slug: "index" },
            { label: "Installation", slug: "start-here/installation" },
            { label: "Getting Started", slug: "start-here/getting-started" },
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

- [ ] **Step 2: Verify build passes**

```bash
cd packages/docs && bun run build
```

Expected: Build succeeds. There will be warnings about missing pages (mcp-servers, hooks, agent-definitions, first-remote-session) — that's fine, they'll be created in Chunk 2.

Note: If Starlight errors on missing slugs, temporarily comment out the 4 not-yet-created entries and uncomment them in Chunk 2.

- [ ] **Step 3: Commit**

```bash
git add packages/docs/astro.config.mjs
git commit -m "docs: replace autogenerate sidebar with explicit topic-cluster layout"
```

---

## Chunk 2: Merge Overlapping Pages

### Task 8: Merge quick-setup + getting-started into one page

**Files:**
- Modify: `start-here/getting-started.mdx`
- Read: `guides/quick-setup.mdx` (source material)
- Delete: `guides/quick-setup.mdx`

- [ ] **Step 1: Read both files to understand overlap**

Read `start-here/getting-started.mdx` and `guides/quick-setup.mdx`. Identify unique content in each.

- [ ] **Step 2: Rewrite getting-started.mdx**

Merge into a single coherent page with this structure:
1. **Requirements** — from installation prerequisites
2. **Install PizzaPi** — `bunx pizzapi` or npm
3. **Run your first session** — standalone mode, no relay needed
4. **What's next** — links to relay setup, customization, deployment

Frontmatter:
```yaml
---
title: Getting Started
description: Install PizzaPi and run your first AI coding session in under 5 minutes.
---
```

- [ ] **Step 3: Delete quick-setup.mdx**

```bash
rm packages/docs/src/content/docs/guides/quick-setup.mdx
```

- [ ] **Step 4: Verify build**

```bash
cd packages/docs && bun run build
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/docs/
git commit -m "docs: merge quick-setup and getting-started into single page"
```

### Task 9: Merge safe-mode into sandbox

**Files:**
- Modify: `security/sandbox.mdx`
- Read: `guides/safe-mode.mdx` (source material)
- Delete: `guides/safe-mode.mdx`

- [ ] **Step 1: Read both files**

Read `security/sandbox.mdx` and `guides/safe-mode.mdx`.

- [ ] **Step 2: Add Safe Mode section to sandbox.mdx**

Add a new `## Safe Mode & Startup Diagnostics` section at the end of `security/sandbox.mdx` with the following content from safe-mode.mdx:
- Skip flags (`PIZZAPI_NO_MCP`, `PIZZAPI_NO_PLUGINS`, `PIZZAPI_NO_HOOKS`, `PIZZAPI_NO_RELAY`)
- `pizza --safe` command
- `mcpTimeout` tuning
- `slowStartupWarning` config
- Troubleshooting slow startup

Update the page frontmatter description to include safe mode:
```yaml
description: OS-level sandboxing for agent tool execution and safe mode startup diagnostics.
```

- [ ] **Step 3: Delete safe-mode.mdx**

```bash
rm packages/docs/src/content/docs/guides/safe-mode.mdx
```

- [ ] **Step 4: Delete guides/ directory if now empty**

```bash
rmdir packages/docs/src/content/docs/guides/ 2>/dev/null || true
```

- [ ] **Step 5: Verify build**

```bash
cd packages/docs && bun run build
```

- [ ] **Step 6: Commit**

```bash
git add -A packages/docs/
git commit -m "docs: merge safe-mode into sandbox page"
```

---

## Chunk 3: New Page — MCP Servers

### Task 10: Write MCP Servers page

**Files:**
- Create: `customization/mcp-servers.mdx`
- Reference: `packages/cli/src/extensions/mcp-extension.ts` (config parsing)
- Reference: `packages/cli/src/extensions/mcp.ts` (transport details)
- Reference: `packages/cli/src/extensions/mcp-oauth.ts` (OAuth flow)
- Reference: `packages/cli/src/config.ts` (PizzaPiConfig interface)

- [ ] **Step 1: Read source files for accuracy**

Read the MCP extension source to confirm config format, transport types, and runtime commands.

- [ ] **Step 2: Write mcp-servers.mdx**

Create `packages/docs/src/content/docs/customization/mcp-servers.mdx` with:

```yaml
---
title: MCP Servers
description: Connect Model Context Protocol servers to give the agent additional tools — web search, databases, custom APIs, and more.
---
```

Sections (see spec for detailed outlines):

1. **What are MCP servers** — One paragraph. MCP servers expose tools the agent can call.
2. **Configuration** — Where config goes (`~/.pizzapi/config.json` global, `.pizzapi/config.json` project). Two config formats: `mcpServers{}` (preferred, Claude Code compatible) and `mcp.servers[]` (also supported).
3. **STDIO transport** — Full example with Tavily. Fields: `command`, `args`, `env`, `cwd`.
4. **HTTP / Streamable HTTP transport** — URL-based. Fields: `url`, `transport` (sse/streamable), `headers`.
5. **OAuth for HTTP servers** — Explain the OAuth flow. Note experimental status if applicable.
6. **Managing servers at runtime** — `/mcp` command, `/mcp disable`, `/mcp enable`, `disabledMcpServers` config.
7. **Troubleshooting** — `mcpTimeout`, `PIZZAPI_NO_MCP=1`, common errors.
8. **Examples** — 2-3 complete config examples.

Use Starlight components: `Aside` for tips/warnings, `Tabs` for config format comparison, code blocks for all examples.

- [ ] **Step 3: Verify build**

```bash
cd packages/docs && bun run build
```

- [ ] **Step 4: Commit**

```bash
git add packages/docs/src/content/docs/customization/mcp-servers.mdx
git commit -m "docs: add MCP Servers guide"
```

---

## Chunk 4: New Page — Hooks

### Task 11: Write Hooks page

**Files:**
- Create: `customization/hooks.mdx`
- Reference: `packages/cli/src/extensions/hooks.ts` (hook execution)
- Reference: `packages/cli/src/config.ts` (HooksConfig, HookMatcher, HookEntry interfaces)

- [ ] **Step 1: Read source for hook config structure and all events**

Read `packages/cli/src/config.ts` for the `HooksConfig` interface (all event types), `HookMatcher`, and `HookEntry` types.

- [ ] **Step 2: Write hooks.mdx**

Create `packages/docs/src/content/docs/customization/hooks.mdx` with:

```yaml
---
title: Hooks
description: Write lifecycle hooks that observe, transform, or block agent actions — lint on save, guard inputs, inject context, and more.
---
```

Sections:

1. **What are hooks** — Shell commands at lifecycle points. Can observe, transform, or block.
2. **Where to define hooks** — `~/.pizzapi/config.json` (global) and `.pizzapi/config.json` (project, needs `allowProjectHooks: true`).
3. **Hook events** — Full table from `HooksConfig` interface:

   | Event | When | Can block? | Uses matchers? |
   |-------|------|------------|----------------|
   | `PreToolUse` | Before tool call | Yes (exit 2) | Yes |
   | `PostToolUse` | After tool completes | No | Yes |
   | `Input` | User sends input | Yes (exit 2) | No |
   | `BeforeAgentStart` | Before agent turn | No (can inject) | No |
   | `UserBash` | User runs ! command | Yes (exit 2) | No |
   | `SessionBeforeSwitch` | Before session switch | Yes (exit 2) | No |
   | `SessionBeforeFork` | Before session fork | Yes (exit 2) | No |
   | `SessionShutdown` | Process exit | No | No |
   | `SessionBeforeCompact` | Before compaction | Yes (exit 2) | No |

4. **Writing a hook** — I/O protocol:
   - Receives JSON on stdin
   - Exit 0 = allow, exit 2 = block
   - Stdout JSON: `{ decision, reason, text, action, additionalContext, systemPrompt }`

5. **Config format** — Show `HookMatcher` (for PreToolUse/PostToolUse) vs `HookEntry[]` (for other events):
   ```jsonc
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash|Edit|Write",
           "hooks": [
             { "command": "~/.pizzapi/hooks/lint.sh", "timeout": 10000 }
           ]
         }
       ],
       "Input": [
         { "command": "~/.pizzapi/hooks/input-guard.sh" }
       ]
     }
   }
   ```

6. **Matchers** — Regex patterns: `"Bash"`, `"Edit|Write"`, `".*"`.

7. **Claude Code compatibility** — Plugins can also define hooks via `hooks/hooks.json`. Cross-link to Claude Code Plugins page.

8. **Examples** — 3 hooks:
   - RTK token optimization (PreToolUse)
   - Input sanitizer (Input)
   - Pre-compaction checkpoint (SessionBeforeCompact)

9. **Project hooks trust model** — `allowProjectHooks` gate, why it exists.

- [ ] **Step 3: Verify build**

```bash
cd packages/docs && bun run build
```

- [ ] **Step 4: Commit**

```bash
git add packages/docs/src/content/docs/customization/hooks.mdx
git commit -m "docs: add Hooks guide"
```

---

## Chunk 5: New Page — Agent Definitions

### Task 12: Write Agent Definitions page

**Files:**
- Create: `customization/agent-definitions.mdx`
- Reference: `packages/cli/src/` (agent discovery, subagent tool implementation)
- Reference: existing `customization/subagents.mdx` (for content to extract)

- [ ] **Step 1: Read subagents.mdx for agent definition content to extract**

Identify the agent definition sections currently in `subagents.mdx`.

- [ ] **Step 2: Write agent-definitions.mdx**

Create `packages/docs/src/content/docs/customization/agent-definitions.mdx` with:

```yaml
---
title: Agent Definitions
description: Create reusable agent definitions with scoped tools, custom instructions, and model overrides for the subagent tool.
---
```

Sections:

1. **What are agent definitions** — Markdown files defining specialized agents.
2. **File format** — Full frontmatter spec:
   ```markdown
   ---
   name: researcher
   description: Read-only codebase research and analysis
   tools: read,grep,find,ls
   model: claude-sonnet-4-20250514
   ---
   Body text becomes the agent's system prompt.
   ```
   Fields: `name`, `description`, `tools`, `model`, `provider`.

3. **Discovery paths** — Where PizzaPi looks:
   - `~/.pizzapi/agents/` (global)
   - `<cwd>/.pizzapi/agents/` (project-local)
   - `~/.claude/agents/` (Claude Code compat)
   - `agentScope` parameter: `"user"` (default), `"project"`, `"both"`

4. **Tool restrictions** — How `tools:` limits access. Comma-separated names. Empty = all tools. MCP tools by prefixed name.

5. **Using agents** — Two methods:
   - `subagent` tool (inline, blocks) — link to Subagents page
   - `spawn_session` (background, triggers) — brief mention

6. **Built-in `task` agent** — Always available, no file needed.

7. **Examples** — 3 complete agent definition files:
   - `researcher.md`
   - `refactorer.md`
   - `reviewer.md`

- [ ] **Step 3: Verify build**

```bash
cd packages/docs && bun run build
```

- [ ] **Step 4: Commit**

```bash
git add packages/docs/src/content/docs/customization/agent-definitions.mdx
git commit -m "docs: add Agent Definitions guide"
```

---

## Chunk 6: Expand Skills, Cross-link Existing Pages, New Tutorial

### Task 13: Expand Skills page

**Files:**
- Modify: `customization/skills.mdx`

- [ ] **Step 1: Read current skills page**

- [ ] **Step 2: Add new sections**

Add to the existing skills page:

1. **SKILL.md frontmatter** — Full spec with all supported fields (`name`, `description`, `tools`).
2. **Skill matching** — How the agent decides which skills apply (description matching, manual `/skill:name`).
3. **Referencing files** — `${CLAUDE_PLUGIN_ROOT}` for plugin skills, relative paths resolved against skill directory.
4. **Agent Skills standard** — Brief mention of agentskills.io compatibility.
5. **More examples** — 2 additional real-world skill examples beyond the existing Next.js one.

- [ ] **Step 3: Verify build**

```bash
cd packages/docs && bun run build
```

- [ ] **Step 4: Commit**

```bash
git add packages/docs/src/content/docs/customization/skills.mdx
git commit -m "docs: expand Skills page with frontmatter spec, matching, and examples"
```

### Task 14: Add cross-links to trimmed pages

**Files:**
- Modify: `customization/configuration.mdx`
- Modify: `customization/claude-plugins.mdx`
- Modify: `customization/subagents.mdx`

- [ ] **Step 1: Update configuration.mdx**

Add a cross-link section near the top (after the config file table) pointing to dedicated guides:

```mdx
<Aside type="tip" title="Dedicated guides">
  For in-depth setup of specific features, see:
  - [MCP Servers](/PizzaPi/customization/mcp-servers/) — connecting external tool servers
  - [Hooks](/PizzaPi/customization/hooks/) — lifecycle scripts that observe or block agent actions
  - [Skills](/PizzaPi/customization/skills/) — extending the agent with domain knowledge
  - [Agent Definitions](/PizzaPi/customization/agent-definitions/) — creating reusable specialized agents
</Aside>
```

Remove any detailed MCP or hooks content that's now covered in dedicated pages — keep only the config key reference table entries.

- [ ] **Step 2: Update claude-plugins.mdx**

At the start of the Hooks section, add:
```mdx
<Aside>
  Plugins can bundle hooks in `hooks/hooks.json`. For full hooks documentation — including standalone hooks outside plugins — see the [Hooks guide](/PizzaPi/customization/hooks/).
</Aside>
```

Keep the plugin-specific hooks content (how plugins define hooks, the JSON format) but trim any general hooks explanation that's now in the dedicated page.

- [ ] **Step 3: Update subagents.mdx**

At the start of the Agent Definitions section, add:
```mdx
<Aside>
  For a complete guide to writing agent definitions — frontmatter fields, discovery paths, tool restrictions — see [Agent Definitions](/PizzaPi/customization/agent-definitions/).
</Aside>
```

Trim the agent definition details (keep a brief summary + link).

- [ ] **Step 4: Fix internal cross-links across all moved pages**

Search all `.mdx` files for links containing `/guides/` and update to new paths:
- `/guides/installation/` → `/start-here/installation/`
- `/guides/cli-reference/` → `/running/cli-reference/`
- `/guides/standalone-mode/` → `/running/standalone-mode/`
- `/guides/runner-daemon/` → `/running/runner-daemon/`
- `/guides/self-hosting/` → `/deployment/self-hosting/`
- `/guides/tailscale/` → `/deployment/tailscale/`
- `/guides/mac-setup/` → `/deployment/mac-setup/`
- `/guides/configuration/` → `/customization/configuration/`
- `/guides/skills/` → `/customization/skills/`
- `/guides/claude-plugins/` → `/customization/claude-plugins/`
- `/guides/subagents/` → `/customization/subagents/`
- `/guides/sandbox/` → `/security/sandbox/`
- `/guides/safe-mode/` → `/security/sandbox/`
- `/guides/development/` → `/reference/development/`

Use grep/sed to find and replace across all files:
```bash
cd packages/docs/src/content/docs
grep -rl '/guides/' . --include='*.mdx' | head -20
# Then fix each reference
```

- [ ] **Step 5: Verify build**

```bash
cd packages/docs && bun run build
```

- [ ] **Step 6: Commit**

```bash
git add -A packages/docs/
git commit -m "docs: add cross-links, trim duplicated content, fix internal links"
```

### Task 15: Write "Your First Remote Session" tutorial

**Files:**
- Create: `start-here/first-remote-session.mdx`

- [ ] **Step 1: Write the tutorial page**

Create `packages/docs/src/content/docs/start-here/first-remote-session.mdx` with:

```yaml
---
title: Your First Remote Session
description: Set up the PizzaPi relay server and stream your first AI coding session to the browser.
---
```

Sections:

1. **Prerequisites** — PizzaPi installed, Docker available
2. **Start the relay server** — `pizza web` command, what it does
3. **Connect your CLI** — `pizza setup`, enter relay URL, get API key
4. **Open the web UI** — Browse to localhost:7492, see session list
5. **Stream a session** — Start `pizza` in terminal, watch it appear in browser
6. **What's next** — Links to: Runner Daemon (headless), Self-Hosting (remote), Tailscale (HTTPS)

Use `Steps` component for the linear flow. Use `Aside` for tips. Keep it concise — this is a tutorial, not reference.

- [ ] **Step 2: Add to sidebar config**

Add `{ label: "Your First Remote Session", slug: "start-here/first-remote-session" }` to the "Start Here" section in `astro.config.mjs`.

- [ ] **Step 3: Verify build**

```bash
cd packages/docs && bun run build
```

- [ ] **Step 4: Commit**

```bash
git add packages/docs/src/content/docs/start-here/first-remote-session.mdx packages/docs/astro.config.mjs
git commit -m "docs: add Your First Remote Session tutorial"
```

---

## Chunk 7: Update index, update AGENTS.md, final verification

### Task 16: Update index.mdx

**Files:**
- Modify: `index.mdx`

- [ ] **Step 1: Update feature links and navigation**

Update any links in `index.mdx` that point to old `/guides/` paths. Update the feature highlights to reflect the new section names.

- [ ] **Step 2: Commit**

```bash
git add packages/docs/src/content/docs/index.mdx
git commit -m "docs: update index page links for new structure"
```

### Task 17: Update AGENTS.md with MCP config preference

**Files:**
- Modify: `AGENTS.md` (project root)

- [ ] **Step 1: Add MCP config convention**

Add under Development Notes:

```markdown
## Configuration Conventions

- **MCP config format:** Always use the `mcpServers{}` format (Claude Code compatible) as the preferred format. The `mcp.servers[]` array format is supported but not preferred. Claude Code compatibility is always the priority.
```

- [ ] **Step 2: Update docs page references in AGENTS.md**

Update the docs page mapping table to reflect new paths:

| Topic | Doc page |
|-------|----------|
| CLI commands & flags | `running/cli-reference.mdx` |
| Config, env vars | `customization/configuration.mdx` |
| MCP servers | `customization/mcp-servers.mdx` |
| Hooks | `customization/hooks.mdx` |
| Skills | `customization/skills.mdx` |
| Agent definitions | `customization/agent-definitions.mdx` |
| Claude plugins | `customization/claude-plugins.mdx` |
| Subagents | `customization/subagents.mdx` |
| `pizza web`, Docker | `deployment/self-hosting.mdx` |
| Tailscale HTTPS | `deployment/tailscale.mdx` |
| Runner daemon | `running/runner-daemon.mdx` |
| Installation | `start-here/installation.mdx` |
| Sandbox & safe mode | `security/sandbox.mdx` |
| Architecture | `reference/architecture.mdx` |
| Server env vars | `reference/environment-variables.mdx` |

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md with MCP config preference and new doc paths"
```

### Task 18: Final build verification and cleanup

- [ ] **Step 1: Full build**

```bash
cd packages/docs && bun run build
```

Expected: Clean build with no errors. All pages render.

- [ ] **Step 2: Check for orphaned files**

```bash
# Should be empty — all files should be in new directories
ls packages/docs/src/content/docs/guides/ 2>/dev/null && echo "WARN: guides/ still has files" || echo "OK: guides/ removed"
```

- [ ] **Step 3: Check for broken internal links**

```bash
cd packages/docs/src/content/docs
grep -rn '/guides/' . --include='*.mdx' | grep -v 'node_modules'
```

Expected: No matches (all old `/guides/` links updated).

- [ ] **Step 4: Final commit if any fixups needed**

```bash
git add -A
git diff --cached --stat
# Only commit if there are changes
git commit -m "docs: final cleanup and link fixes" || true
```

- [ ] **Step 5: Push**

```bash
git push -u origin docs/reorganization-spec
```
