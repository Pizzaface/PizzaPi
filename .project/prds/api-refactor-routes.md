---
name: api-refactor-routes
description: Split monolithic API handler into modular route files organized by domain/feature with improved maintainability and testability
status: backlog
created: 2026-03-04T20:19:29Z
---

# PRD: API Route Refactoring

## Executive Summary

The PizzaPi server's REST API is currently defined in a single monolithic file (`packages/server/src/routes/api.ts`, 1000+ lines) that handles all endpoints—auth, runners, sessions, files, push notifications, and settings. This refactoring initiative splits the API into modular, domain-organized route modules to improve:

- **Maintainability**: Each feature domain has its own router, reducing cognitive load and making changes easier to locate and reason about.
- **Testability**: Route modules can be tested independently with clear separation of concerns.
- **Discoverability**: Developers can quickly find endpoints by exploring the routes directory structure.
- **Extensibility**: New features can be added in new route files without touching the monolith.
- **Code Review**: PRs targeting specific features are easier to review when they're not entangled with unrelated routes.

The refactored structure maintains **100% backward compatibility** with existing API contracts and preserves all current behavior, logging, and security measures.

---

## Problem Statement

### Current Issues

1. **Single Large File**: `routes/api.ts` is a 1000+ line god file that handles authentication, runner management, session handling, file operations, push notifications, and user settings all in one place.

2. **Difficult Navigation**: Finding a specific endpoint requires scrolling through hundreds of lines or using search. The logical grouping of related endpoints is unclear.

3. **Testing Challenges**: 
   - Testing a single endpoint requires importing and running the entire handler.
   - Hard to mock specific route logic without affecting others.
   - No isolation between test cases for different domains.

4. **Merge Conflicts**: When multiple developers add features to different endpoints, they inevitably conflict in the same large file.

5. **Risk of Refactoring**: Making changes is risky because one route module handles unrelated features; a small change can have unexpected side effects.

6. **Onboarding Friction**: New team members must understand the entire `routes/api.ts` structure to add a simple endpoint.

7. **Import Clutter**: The single file imports dozens of utilities, making it hard to understand dependencies at a glance.

### Why Now?

- The API is stable and well-tested, making refactoring low-risk.
- New features are increasingly difficult to add due to file size and cognitive complexity.
- The codebase would benefit from improved organization before further growth.

---

## User Stories & Use Cases

### As a Developer

**US-1: Add a new endpoint**
> I should be able to find the relevant route module, understand its structure, and add a new endpoint in ~15 minutes without worrying about side effects on unrelated routes.

**Acceptance Criteria:**
- [ ] Router files are organized by domain (runners, sessions, etc.)
- [ ] Each router has a clear pattern and entry point
- [ ] Adding an endpoint requires only modifying the relevant router file and handler
- [ ] No need to edit `handler.ts` for simple endpoint additions

**US-2: Debug a failing endpoint**
> I should be able to find the endpoint handler in under 1 minute and trace its dependencies clearly.

**Acceptance Criteria:**
- [ ] Endpoint location is obvious from the API path
- [ ] Router file contains all related middleware and validation for that domain
- [ ] Import statements show clear dependency chains

**US-3: Test route logic in isolation**
> I should write tests that exercise a single route without spinning up the entire API handler.

**Acceptance Criteria:**
- [ ] Each router exports a testable handler function
- [ ] Tests can import and call the router directly
- [ ] Mocking shared dependencies (auth, DB) is straightforward
- [ ] Test files can be co-located with route modules

**US-4: Understand API structure on day 1**
> As a new team member, I should understand the API structure at a glance without reading documentation.

**Acceptance Criteria:**
- [ ] `routes/` directory structure mirrors API domains (runners, sessions, etc.)
- [ ] Each router file has a clear comment block describing its endpoints
- [ ] Shared utilities are in dedicated files with single responsibilities

---

## Requirements

### Functional Requirements

#### FR-1: Modular Router Structure
Create separate router modules for each API domain:

1. **`routes/auth.ts`**
   - `POST /api/register` — register new user
   - `GET /api/signup-status` — check if signups allowed
   - Auth validation and password policy enforcement

2. **`routes/runners.ts`**
   - `GET /api/runners` — list runners
   - `POST /api/runners/spawn` — spawn new session
   - `POST /api/runners/restart` — restart runner
   - `POST /api/runners/stop` — stop runner
   - `POST /api/runners/terminal` — create terminal
   - `GET /api/runners/:id/recent-folders` — list recent folders
   - Runner skill management (list, get, create, update, delete)
   - File operations (list, search, read)
   - Git operations (status, diff)

3. **`routes/sessions.ts`**
   - `GET /api/sessions` — list sessions
   - `GET /api/sessions/pinned` — list pinned sessions
   - `PUT /api/sessions/:id/pin` — pin session
   - `DELETE /api/sessions/:id/pin` — unpin session

4. **`routes/attachments.ts`**
   - `POST /api/sessions/:id/attachments` — upload attachment
   - `GET /api/attachments/:id` — download attachment

5. **`routes/chat.ts`**
   - `POST /api/chat` — chat endpoint
   - `GET /api/models` — list available models

6. **`routes/push.ts`**
   - `GET /api/push/vapid-public-key` — get push public key
   - `POST /api/push/subscribe` — subscribe to push
   - `POST /api/push/unsubscribe` — unsubscribe from push
   - `GET /api/push/subscriptions` — list subscriptions
   - `PUT /api/push/events` — update enabled events
   - `POST /api/push/answer` — answer user question from push

7. **`routes/settings.ts`**
   - `GET /api/settings/hidden-models` — get hidden models
   - `PUT /api/settings/hidden-models` — set hidden models

#### FR-2: Unified Entry Point
Maintain `handler.ts` as the single entry point:

- `handler.ts` dispatches `/api/auth/*` to `auth` router
- `handler.ts` dispatches `/api/runners/*` to `runners` router
- `handler.ts` dispatches other paths to appropriate routers
- **No change to external API** — all existing routes remain at the same paths with identical behavior

#### FR-3: Shared Utilities
Extract and organize shared utilities:

1. **`routes/utils.ts`**
   - `parseJsonArray()` — safely parse JSON arrays
   - `pickRunnerIdLeastLoaded()` — pick least-loaded runner
   - `pickRunnerIdForCwd()` — pick runner by directory
   - `mintEphemeralApiKey()` — create temporary API keys

2. **`routes/types.ts`** (if needed)
   - Shared TypeScript types and interfaces for all routers

#### FR-4: Auth & Security
- All routers inherit auth/security from `handler.ts` validation or middleware
- `requireSession()` and `validateApiKey()` continue to work as middleware in `handler.ts`
- Public endpoints (register, signup-status) are handled in auth router
- No security regressions

#### FR-5: Testing Structure
- Each router exports a default handler function that matches the signature: `(req: Request, url: URL) => Promise<Response | undefined>`
- Tests can import routers directly and call them with mock requests/URLs
- Example: `test("POST /api/runners/spawn", async () => { await runnersRouter(req, url); })`

---

### Non-Functional Requirements

#### NFR-1: Performance
- Refactoring should not impact request latency
- Router dispatch logic should be minimal (no regex parsing overhead)
- No additional DB or network calls

#### NFR-2: Backward Compatibility
- All existing API endpoints must remain available at the same paths
- All existing response schemas must be identical
- HTTP status codes must be unchanged
- Error messages must be identical

#### NFR-3: Code Quality
- Each router must pass TypeScript strict mode
- No new ESLint warnings
- Type coverage must be maintained or improved

#### NFR-4: Maintainability
- Each router file should be ≤ 500 lines (if it exceeds 500, further split by sub-feature)
- Shared logic must be de-duplicated and centralized in `routes/utils.ts`
- Clear imports and minimal circular dependencies

#### NFR-5: Testability
- Each router must be independently testable without running the full server
- Mocking dependencies must be straightforward (pass auth, DB, etc. as parameters or use dependency injection)
- Test files can be co-located: `routes/runners.ts` → `routes/runners.test.ts`

---

## Success Criteria

### Measurable Outcomes

1. **Code Organization**
   - [ ] `routes/` directory has 7 clean router modules (auth, runners, sessions, attachments, chat, push, settings)
   - [ ] No single router file exceeds 500 lines
   - [ ] Shared utilities consolidated in `routes/utils.ts`

2. **Backward Compatibility**
   - [ ] All 50+ existing API endpoints remain available at their original paths
   - [ ] No regression tests fail
   - [ ] Load tests show ≤ 5% change in latency (typically improvement due to better structure)

3. **Test Coverage**
   - [ ] Each router module has unit tests
   - [ ] Critical routes (spawn, register, pin) have comprehensive tests
   - [ ] Test files use clear naming: `routes/runners.test.ts`, etc.
   - [ ] Test coverage for routers remains ≥ 80%

4. **Developer Experience**
   - [ ] New endpoints can be added to the correct router in < 15 minutes
   - [ ] Endpoint location is obvious from the API path structure
   - [ ] Router imports show clear dependencies at a glance

5. **Code Review**
   - [ ] Feature PRs targeting a specific domain are now isolated to a single router file
   - [ ] Merge conflicts reduced due to modular structure

---

## Constraints & Assumptions

### Technical Constraints

1. **No Framework**: PizzaPi doesn't use Express, Hono, or other frameworks. Routing is manual URL matching in `handler.ts`. This constraint must be maintained.

2. **Bun Runtime**: All code must work with Bun (not Node.js). Async/await patterns must be Bun-compatible.

3. **Fetch API**: Request/response handling uses the Fetch API (Request, Response objects), not Node streams.

4. **Single Port**: All routes run on the same HTTP port; no multi-process dispatch.

5. **Existing Middleware**: Auth checks (`requireSession`, `validateApiKey`) are centralized in `handler.ts`. Routers cannot override or bypass them (by design).

### Architectural Assumptions

1. **No Router Library**: We won't introduce external routing libraries (Express, Hono, etc.). Manual URL matching is maintained.

2. **Stateless Routers**: Each router is stateless—all state (auth, DB, Redis, sockets) is passed in or accessed via imports.

3. **Shared Imports**: Routers import from common modules (auth, DB, WebSocket registry, etc.) without circular dependencies.

4. **Synchronous Dispatch**: `handler.ts` synchronously dispatches to the appropriate router based on URL path (not async).

### Timeline Assumptions

1. **Single Sprint**: Refactoring should complete in 1-2 sprints without blocking new feature work.
2. **Low Risk**: Because the API is stable and well-tested, refactoring risk is minimal.
3. **No Concurrent Changes**: Refactoring should not happen simultaneously with major feature additions to the affected routes.

---

## Out of Scope

The following items are explicitly NOT included in this refactoring:

1. **WebSocket Routes**: Socket.IO namespaces (runner, TUI, relay) remain in `ws/` and are not affected.

2. **Static File Serving**: The `serveStaticFile()` logic stays in `static.ts`.

3. **Authentication Handler**: The `better-auth` handler (`/api/auth/`) delegation remains in `handler.ts` (it's a different system).

4. **Health & Version Endpoints**: These simple endpoints can stay in `handler.ts` or be moved to the auth router—not a priority.

5. **API Framework Introduction**: We're not adopting Express, Hono, or other frameworks. Manual routing continues.

6. **Endpoint Logic Changes**: No endpoint behavior is modified. This is purely organizational refactoring.

7. **New Endpoints**: No new endpoints are added during this refactoring. Feature additions come after.

---

## Dependencies

### Internal Dependencies

- **`packages/server/src/auth.ts`**: User/API key auth, DB access, signup checks
- **`packages/server/src/middleware.ts`**: `requireSession()`, `validateApiKey()` functions
- **`packages/server/src/handler.ts`**: Main request dispatcher (updated to delegate to new routers)
- **`packages/server/src/security.ts`**: Rate limiting, email/password validation, directory checks
- **`packages/server/src/validation.ts`**: Skill name validation, etc.
- **`packages/server/src/ws/sio-registry.ts`**: Runner/session WebSocket registry
- **`packages/server/src/sessions/store.ts`**: Session storage (Redis, persistent)
- **`packages/server/src/attachments/store.ts`**: File attachment storage
- **`packages/server/src/push.ts`**: Push notification logic
- **`packages/server/src/runner-recent-folders.ts`**: Recent folder tracking
- **`packages/server/src/user-hidden-models.ts`**: User model preferences
- **`@pizzapi/tools`, `@mariozechner/pi-*` packages**: Agent tooling, models

### External Dependencies

- None new—uses existing Bun, TypeScript, and runtime APIs

### Team Dependencies

- **Backend team**: Responsible for refactoring and testing
- **Testing team**: Can optimize tests once routers are split
- **DevOps**: May need to update monitoring/logging if handler structure changes (unlikely)

---

## Implementation Notes

### Suggested Router Signature

Each router should follow this pattern for consistency:

```typescript
// routes/runners.ts
export default async function handleRunnersRoute(
  req: Request,
  url: URL,
  identity?: Identity  // optional, pre-validated
): Promise<Response | undefined> {
  // Check path patterns and dispatch to handler logic
  // Return undefined if path doesn't match this router
}
```

Or simpler, if auth is always checked in `handler.ts` first:

```typescript
export async function handleRunnersRoute(req: Request, url: URL): Promise<Response | undefined> {
  // Body...
}
```

### Dispatch Pattern in handler.ts

```typescript
// handler.ts
export async function handleFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Auth routes
  if (url.pathname.startsWith("/api/auth")) {
    return await handleAuthRoute(req, url);
  }

  // Runners
  if (url.pathname.startsWith("/api/runners")) {
    return await handleRunnersRoute(req, url);
  }

  // Sessions
  if (url.pathname.startsWith("/api/sessions")) {
    return await handleSessionsRoute(req, url);
  }

  // ... other routers ...

  // Static files
  const staticRes = await serveStaticFile(url.pathname);
  if (staticRes) return staticRes;

  return Response.json({ error: "Not found" }, { status: 404 });
}
```

### Testing Pattern

```typescript
// routes/runners.test.ts
import { test, expect } from "bun:test";
import { handleRunnersRoute } from "./runners";

test("GET /api/runners returns list", async () => {
  const req = new Request("http://localhost/api/runners", { method: "GET" });
  const url = new URL(req.url);
  const res = await handleRunnersRoute(req, url);
  expect(res?.status).toBe(200);
});
```

---

## Risk Assessment

### Low-Risk Areas
- **Auth router**: Straightforward path matching, minimal logic
- **Settings router**: Simple CRUD operations, isolated feature
- **Push router**: Well-tested, low-coupling with other domains

### Medium-Risk Areas
- **Runners router**: Most complex, many endpoints, WebSocket integration
- **Sessions router**: Involves session state, attachment integration
- **Chat router**: Depends on multiple external services (models, tools)

### Mitigation Strategies
1. **Refactor incrementally**: Start with simple routers (settings, push), move to complex ones (runners).
2. **Maintain full test coverage**: Run existing tests after each router is refactored.
3. **Feature parity verification**: Automated tests confirm each endpoint returns identical responses before/after.
4. **Rollback plan**: If issues occur, revert to the monolithic handler in under 1 hour.

---

## Next Steps (Post-Refactoring)

Once the refactoring is complete, the following improvements become easier:

1. **Router-Level Middleware**: Each router can have its own middleware (logging, rate limiting per domain).
2. **Versioning**: Different API versions can be routed to different router implementations.
3. **Load Balancing**: Router dispatch logic could be extended to load-balance across services (if needed in future).
4. **Documentation Generation**: Router structure makes it easier to auto-generate OpenAPI/Swagger docs.
5. **Feature Flags**: Feature flags can be applied at the router level.

---

## Questions for Alignment

Before decomposing into tasks, please confirm:

1. **Is the 7-router split (auth, runners, sessions, attachments, chat, push, settings) the right organization?**
   - Should any be combined or further split?

2. **Should we refactor incrementally (one router at a time) or all at once?**

3. **Are there any routers that should be prioritized first?**

4. **Should we include comprehensive tests for all routers, or focus on critical paths (spawn, register, pin)?**

5. **Timeline: Is 1-2 sprints acceptable, or is this a lower priority?**
