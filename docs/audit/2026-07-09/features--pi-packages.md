# Audit: features/pi-packages.mdx
Verdict: MAJOR ISSUES
Claims checked: 28 | Failed: 9

## Findings

### [P1] Every command is `pi …` but PizzaPi only ships `pizza`/`pizzapi`
- Claim (lines 13, 41-47, 122): "Use `pi install` from the terminal", `pi list`, `pi update`, `pi remove npm:@foo/bar`, `pi config`, and `pi install git:github.com/you/my-pi-package`.
- Reality: PizzaPi's only binaries are `pizza` and `pizzapi` (packages/cli/package.json:13-15, packages/npm/build-npm.ts:225-227). Package verbs are dispatched by `isPackageCommand` and the help text prints `pizza install`/`pizza list`/`pizza update`/`pizza remove`/`pizza config` (packages/cli/src/package-commands.ts:10,35; packages/cli/src/index.ts:339-343). The sibling cli-reference.mdx correctly uses `pizzapi install` etc. (running/cli-reference.mdx:413-440). A PizzaPi-only install has no `pi` on PATH, so every documented command fails.
- Fix: Replace all `pi install|list|update|remove|config` with `pizza` (or `pizzapi`) and align with cli-reference.mdx.

### [P1] Global install path is `~/.pizzapi/settings.json`, not `~/.pi/agent/settings.json`
- Claim (line 36): "By default, packages install globally (`~/.pi/agent/settings.json`)."
- Reality: PizzaPi migrated `~/.pi/agent` → `~/.pizzapi` and sets `PI_CODING_AGENT_DIR` to `defaultAgentDir()` = `~/.pizzapi` (packages/cli/src/config/io.ts:385-387; packages/cli/src/package-commands.ts:176-177). Upstream writes package entries to `agentDir/settings.json` (node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js:463,523). cli-reference.mdx:415 states the correct path `~/.pizzapi/settings.json`.
- Fix: Change `~/.pi/agent/settings.json` to `~/.pizzapi/settings.json`.

### [P1] Project-local path is `.pizzapi/`, not `.pi/`
- Claim (line 36): "Use `-l` for project-local installs (`.pi/settings.json`)".
- Reality: `CONFIG_DIR_NAME` is patched to `.pizzapi` (node_modules/@earendil-works/pi-coding-agent/dist/config.js:398), and project settings/installs resolve under `join(cwd, CONFIG_DIR_NAME)` (package-manager.js:696,1595,1660). The `-l` help itself says "project-local .pizzapi directory" (packages/cli/src/package-commands.ts:38).
- Fix: Replace `.pi/settings.json` with `.pizzapi/settings.json`.

### [P1] "Try Without Installing" (`pi -e`) is not wired into PizzaPi
- Claim (lines 29-33): "Load a package for a single session without persisting it: `pi -e npm:@foo/bar` / `pi -e git:github.com/user/repo`".
- Reality: The `-e`/`--extension` flag is parsed only by upstream's `cli/args` (node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js:120-122) and consumed as `additionalExtensionPaths` in upstream `main()`. PizzaPi has its own `main()` that builds `DefaultResourceLoader` with no `additionalExtensionPaths` and never parses `-e` (packages/cli/src/index.ts:26,462-489; grep for `additionalExtensionPaths`/`-e` in packages/cli/src returns nothing). So `pizza -e <source>` is silently ignored, and `pi -e` does not exist.
- Fix: Either remove the "Try Without Installing" section or wire `additionalExtensionPaths` from a `-e` flag in PizzaPi's `main()` and document it as `pizza -e`.

### [P1] Pinned git packages are NOT skipped by update
- Claim (lines 50-52): "Packages with a pinned version (e.g., `npm:@foo/bar@1.2.3` or `git:...@v1`) are skipped by `pi update`."
- Reality: Only pinned npm sources are skipped; pinned git refs are intentionally included to reconcile the clone with the configured ref (package-manager.js:828-842, comment "Pinned git refs are configured checkout targets, so include them to reconcile an existing clone when the configured ref changes").
- Fix: Restrict the skip claim to npm pins; note pinned git packages are still reconciled on update.

### [P1] Global npm installs do NOT use `npm install -g`
- Claim (line 72): "Global installs use `npm install -g`".
- Reality: `installNpm` runs `npm install <spec> --prefix <installRoot>` (or bun/pnpm equivalents) into a managed prefix `join(agentDir,"npm")` = `~/.pizzapi/npm`; there is no `-g` (package-manager.js:1448-1452,1587-1597,1618-1636,1414-1429). A legacy `npm root -g` lookup is only a read fallback for pre-existing installs (package-manager.js:1602-1613,1638-1652).
- Fix: Replace with "Global installs go into `~/.pizzapi/npm/` (a managed prefix)".

### [P1] Project-local npm dir is `.pizzapi/npm/`, not `.pi/npm/`
- Claim (line 74): "Project-local installs go under `.pi/npm/`".
- Reality: `getNpmInstallRoot("project")` returns `join(cwd, CONFIG_DIR_NAME, "npm")` = `.pizzapi/npm` (package-manager.js:1594-1596; CONFIG_DIR_NAME=".pizzapi" at config.js:398).
- Fix: Change `.pi/npm/` to `.pizzapi/npm/`.

### [P1] Git clone paths use `~/.pizzapi/git/` and `.pizzapi/git/`, not `~/.pi/agent/git/` and `.pi/git/`
- Claim (line 89): "Cloned to `~/.pi/agent/git/<host>/<path>` (global) or `.pi/git/<host>/<path>` (project)".
- Reality: `getGitInstallRoot` returns `join(agentDir,"git")` = `~/.pizzapi/git` for global and `join(cwd, CONFIG_DIR_NAME, "git")` = `.pizzapi/git` for project (package-manager.js:1654-1664,695-696).
- Fix: Replace both paths with `~/.pizzapi/git/<host>/<path>` and `.pizzapi/git/<host>/<path>`.

### [P3] Pi Package Gallery URL is an unverified external claim
- Claim (line 123): "Browse the Pi Package Gallery — https://shittycodingagent.ai/packages".
- Reality: This URL and the Discord invite appear only in this doc; nothing in the repo references or validates them (grep across repo). Cannot be verified against code; risk of dead/misleading link.
- Fix: Verify the gallery URL is live and official (or link to the npm keyword search only).

## Redesign notes
- The page is a near-verbatim copy of upstream pi's package docs and never reconciles with PizzaPi's `.pizzapi` namespace or `pizza`/`pizzapi` binaries; it directly contradicts the correct running/cli-reference.mdx:413-457. Audit should reconcile both pages to one source of truth.
- All path examples (`~/.pi/agent/…`, `.pi/…`) should be globally substituted to `~/.pizzapi/…` / `.pizzapi/…`; this mirrors the same P1 already raised in customization--configuration.md:7-10 and start-here--installation.md.
- The "Try Without Installing" feature either needs a code-side wiring or should be dropped; documenting an unsupported flag is worse than omitting it.
- The pinned-version tip should be split by source type (npm vs git) since behavior differs.
- Filtering example omits `themes` even though the manifest/filter supports it (RESOURCE_TYPES includes "themes", package-manager.js:66); showing `themes` would be consistent with the Creating a Package section.

## Code UX opportunities
- PizzaPi's `main()` diverges from upstream by dropping `-e/--extension` (packages/cli/src/index.ts:460-489). Inheriting upstream's `additionalExtensionPaths` plumbing would restore the documented "try without installing" workflow without a doc change — a one-line loader option.
- `pizza update` silently rewrites to `--extensions` and prints a self-update note (package-commands.ts:159,184-191). The CLI could surface this rewrite in `--help` so users understand the default differs from upstream `pi update`.
- The wrapper exposes both `pizza` and `pizzapi` but docs use neither consistently; a single canonical verb in help text would prevent the `pi` drift recurring.
