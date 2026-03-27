## Inspection: Dish 004 — Terminal Title Override

### Quality Gates
- **Typecheck:** SKIPPED — Pre-existing `bun:sqlite` / `bun:test` resolution errors in the worktree's root tsconfig; unrelated to dish-004. The new code itself typechecks cleanly (confirmed by compiling `packages/cli` directly with no new errors).
- **Tests:** PASS — All 5 dish-004 unit tests pass (`cd packages/cli && bun test src/extensions/pizzapi-title.test.ts`: 5 pass, 0 fail). Root-level `bun test` fails due to a pre-existing Redis preload issue in the worktree, not dish-004.

### Findings

#### P0 (Critical)
- None

#### P1 (Serious)
- None

#### P2 (Moderate)
- None

#### P3 (Minor)
- **Root-CWD trailing space:** When `cwd` is `/`, `basename("/")` returns `""` on POSIX, producing `"🍕 PizzaPi — "` (title ends with `— ` and nothing after). The test acknowledges this explicitly but doesn't guard against it. Practically harmless since running from `/` is nearly impossible in real usage, but a `|| "/"` fallback in `buildPizzapiTitle` would be cleaner.

### Completeness
- Title with session name (em-dashes) — ✅ `🍕 PizzaPi — ${sessionName} — ${cwdBasename}` uses `—` throughout
- Title without session name — ✅ `🍕 PizzaPi — ${cwdBasename}` when `sessionName` is `undefined`
- Session name change updates title — ✅ Hooks `tool_execution_end` and filters on `event.toolName === "set_session_name"`, which fires after the session has been named and `pi.getSessionName()` is already updated
- cwdBasename (not full path) — ✅ `basename(cwd)` from `node:path`
- Registered in factories.ts — ✅ Added to both `buildPizzaPiExtensionFactories()` in `factories.ts` and mirrored in `factories.test.ts`
- Listener cleanup on dispose — N/A — `ExtensionFactory` is typed as `(pi: ExtensionAPI) => void | Promise<void>`; the upstream API exposes no `off()` or disposal mechanism, so no cleanup is expected or possible

### Verdict
**CLEAN_BILL**

### Summary
The implementation is correct, minimal, and well-tested. All three title-update triggers (`session_start`, `session_switch`, `tool_execution_end` for `set_session_name`) are valid events per the upstream API type definitions, and the `ctx.hasUI` guard correctly skips title-setting in headless/RPC mode. The only cosmetic edge case (root-CWD trailing space) is acknowledged in the tests and has no real-world impact.
