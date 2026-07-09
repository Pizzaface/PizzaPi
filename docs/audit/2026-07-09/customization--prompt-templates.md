# Audit: customization/prompt-templates.mdx
Verdict: MAJOR ISSUES
Claims checked: 26 | Failed: 6

## Findings

### [P1] `~/.pizzapi/prompts/` (global) is NOT a discovered path
- Claim (line 28, 31, 71): "`~/.pizzapi/prompts/` | Global — available in all projects" and "The `~/.pizzapi/prompts/` directory is discovered automatically as part of the PizzaPi agent directory."
- Reality: PizzaPi's `buildPromptTemplatePaths` returns exactly 4 paths and `~/.pizzapi/prompts/` is NOT among them (`packages/cli/src/skills.ts:365-371`, test asserts exactly 4 paths: `packages/cli/src/skills.test.ts:478-480`). Upstream `loadPromptTemplates` only loads `agentDir/prompts` when `includeDefaults: true`, but `ResourceLoader.updatePromptsFromPaths` hardcodes `includeDefaults: false` (`node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js:473-477`). A user who creates `~/.pizzapi/prompts/review.md` (as the doc's FileTree shows) will get nothing.
- Fix: Drop the `~/.pizzapi/prompts/` row and the note, or add `join(homedir(), ".pizzapi", "prompts")` to `buildPromptTemplatePaths`.

### [P2] Precedence order is inverted between global `commands/` and project `prompts/`
- Claim (line 26, table lines 28-34): "first match wins (top of this list = highest precedence)" with order: `~/.pizzapi/prompts/` > `~/.pizzapi/commands/` > `<cwd>/.pizzapi/prompts/` > `<cwd>/.pizzapi/commands/` > `<cwd>/.agents/commands/`.
- Reality: Actual load order (after `mergePaths` dedup) is `<cwd>/.pizzapi/prompts` (highest) → `~/.pizzapi/commands` → `<cwd>/.pizzapi/commands` → `<cwd>/.agents/commands` (`packages/cli/src/skills.ts:366-370` order, consumed in `resource-loader.js:299` `mergePaths([...cliEnabledPrompts, ...enabledPrompts], additionalPromptTemplatePaths)`). `dedupePrompts` keeps the first occurrence (`resource-loader.js:702-720`). So project-local `prompts/` BEATS global `commands/`, the opposite of the table.
- Fix: Reorder the table to `<cwd>/.pizzapi/prompts/` first, then `~/.pizzapi/commands/`, etc., and drop the non-existent global `prompts/` row.

### [P2] Undocumented `${N:-default}` substitution and `argument-hint` frontmatter
- Claim (lines 73-79, 64-69): The argument table lists only `$1`, `$@`/`$ARGUMENTS`, `${@:N}`, `${@:N:L}`; the frontmatter table lists only `description`.
- Reality: `substituteArgs` also supports `${N:-default}` (positional arg N with a default when missing/empty) via regex `\$\{(\d+):-([^}]*)\}` (`node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js:57`). `loadTemplateFromFile` also reads a `argument-hint` frontmatter field and exposes it as `argumentHint` (`prompt-templates.js:104`: `frontmatter["argument-hint"]`), which the web UI renders for prompt templates' siblings (Plugin Commands group shows `argumentHint` at `packages/ui/src/components/SessionViewer.tsx:1252`).
- Fix: Document `${N:-default}` in the argument table and `argument-hint` in the frontmatter table.

### [P2] Web UI group headings are named incorrectly
- Claim (lines 159-163): Groups are "Built-in commands", "Extension commands", "Prompt Templates", "Skills".
- Reality: `SessionViewer.tsx` renders group headings "Commands", "Plugin Commands", "Prompt Templates", "Skills" (`packages/ui/src/components/SessionViewer.tsx:1229,1244,1266,1283`). No "Built-in commands" or "Extension commands" headings exist.
- Fix: Rename to "Commands" and "Plugin Commands" to match the picker (and align with `features/slash-commands.mdx` which already uses "Prompts"/"Extensions" inconsistently — see Redesign notes).

### [P3] `description` fallback truncation not mentioned
- Claim (line 67): "If omitted, the first non-empty line of the body is used."
- Reality: The fallback also truncates to 60 characters and appends "…" (`prompt-templates.js:99-103`: `firstLine.slice(0, 60)` + `description += "..."`). Users authoring long first lines will see a truncated picker description with no explanation.
- Fix: Add "(truncated to 60 characters)" to the description row.

### [P3] Non-recursive caution is misplaced and scoped too narrowly
- Claim (line 188): "Discovery within prompt template directories is non-recursive" — placed under "Claude Code Compatibility".
- Reality: `loadTemplatesFromDir` is non-recursive for ALL discovered dirs (`prompt-templates.js:121-148`: `readdirSync` + `isFile && endsWith(".md")`, subdirs skipped). The caution applies to every row in the directory table, not just Claude Code compatibility.
- Fix: Move the caution up to the "Directory Locations" section so it covers all paths.

## Redesign notes
- The directory table is the load-bearing claim of the page and is doubly wrong (phantom global `prompts/` path + inverted precedence). Rebuild it strictly from `buildPromptTemplatePaths` (`packages/cli/src/skills.ts:365-371`) plus the package-installed prompt paths (`cliEnabledPrompts`/`enabledPrompts` from `resource-loader.js:252,268,299`) which currently take HIGHEST precedence and are entirely undocumented.
- `features/slash-commands.mdx` (line ~18 "Prompts", line ~79 `/reload`) and `web-ui/slash-commands.mdx` (line 93: "Commands for prompt templates defined in `~/.pizzapi/prompts/`") duplicate and contradict this page. `web-ui/slash-commands.mdx:93` repeats the false `~/.pizzapi/prompts/` claim and omits `commands/` entirely. Consolidate the directory list in ONE place and link from the others.
- The page mixes `~/.pizzapi/commands/` (correct, loaded) and `~/.pizzapi/prompts/` (incorrect) as global dirs across the FileTree, the precedence table, and the examples — pick one global location and use it consistently.
- Group-heading names differ across three doc pages ("Built-in commands"/"Commands", "Extension commands"/"Plugin Commands"/"Extensions", "Prompt Templates"/"Prompts"). Standardize on the actual UI strings from `SessionViewer.tsx`.
- The "Creating Your First Template" step writes to `~/.pizzapi/commands/` (correct) but the FileTree and precedence table prominently feature `~/.pizzapi/prompts/` (wrong) — the first thing a user reads contradicts the working example.

## Code UX opportunities
- `buildPromptTemplatePaths` (`packages/cli/src/skills.ts:365-371`) silently omits a global `~/.pizzapi/prompts/` directory even though upstream `loadPromptTemplates` has explicit `globalPromptsDir`/`projectPromptsDir` support gated behind `includeDefaults`. Since PizzaPi forces `includeDefaults: false`, the global prompts dir is dead code. Either add `join(homedir(), ".pizzapi", "prompts")` to match user expectations (and the doc), or surface a one-time warning when `~/.pizzapi/prompts/` exists but is empty-of-results so users aren't confused.
- `dedupePrompts` only emits a `collision` diagnostic (`resource-loader.js:702-720`) but the web UI picker gives no visibility into which path won. Exposing the winning `sourceInfo` (already attached per-template) in the picker would let users debug precedence conflicts without reading code.
- `description` fallback silently truncates at 60 chars (`prompt-templates.js:99-103`). A console/log hint at load time when a description is truncated would help template authors notice.
- `argument-hint` frontmatter is parsed and propagated for plugin commands but prompt templates never display it in the picker (`SessionViewer.tsx:1266-1282` omits `argumentHint` for the Prompt Templates group, unlike the Plugin Commands group at line 1252). Either render it for prompt templates too, or document that `argument-hint` is plugin-command-only.
