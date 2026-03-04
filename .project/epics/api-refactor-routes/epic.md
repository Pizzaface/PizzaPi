---
name: api-refactor-routes
status: backlog
created: 2026-03-04T20:21:09Z
progress: 0%
prd: .project/prds/api-refactor-routes.md
beads_id: (pending sync to Beads)
---

# Epic: API Route Refactoring

## Overview

Refactor the monolithic `packages/server/src/routes/api.ts` (1000+ lines) into seven modular, domain-organized router modules (auth, runners, sessions, attachments, chat, push, settings). Maintains 100% backward compatibility with existing API contracts while improving maintainability, testability, and code organization. The refactored structure enables faster feature development, easier debugging, and clearer code reviews by isolating endpoint logic to feature-specific modules.

## Architecture Decisions

### 1. Modular Router Pattern
- Create seven standalone router modules, each handling a single API domain
- Each router exports a consistent async handler: `(req: Request, url: URL) => Promise<Response | undefined>`
- Routers return `undefined` if the path doesn't match, allowing central dispatcher to try the next router
- **Rationale**: Isolates endpoint logic by domain, reduces cognitive load, and enables parallel development across teams

### 2. Stateless Router Design
- Routers are pure functions with no instance state
- All dependencies (auth context, DB, WebSocket registry, etc.) are passed via imports or parameters
- No circular dependencies between routers
- **Rationale**: Ensures testability, predictability, and composability

### 3. Centralized Dispatcher in handler.ts
- Single source of truth for request routing via sequential path matching
- Handler.ts remains the entry point; no new abstraction layers introduced
- Auth/security validation happens in handler.ts before router dispatch
- **Rationale**: Maintains existing security model and control flow; minimal refactoring risk

### 4. Shared Utilities Consolidation
- Extract common logic into `routes/utils.ts`: `parseJsonArray()`, `pickRunnerIdLeastLoaded()`, `pickRunnerIdForCwd()`, `mintEphemeralApiKey()`
- Optional `routes/types.ts` for shared TypeScript interfaces if needed
- **Rationale**: Eliminates code duplication and makes utilities discoverable

### 5. No New Framework Dependencies
- Continue using manual URL path matching (Fetch API, no Express/Hono)
- Bun runtime compatibility maintained throughout
- **Rationale**: Reduces external dependencies and keeps deployment surface minimal

### 6. Router File Size Constraint
- Each router file must stay ≤ 500 lines (hard limit)
- If a router exceeds 500 lines, split by sub-feature (e.g., runners → runners-spawn.ts, runners-manage.ts)
- **Rationale**: Prevents recreation of the monolith problem; maintains cognitive load at acceptable levels

### 7. Testing at Router Granularity
- Each router has co-located unit tests (e.g., `routes/runners.test.ts`)
- Tests can import and call routers directly without spinning up the full server
- Mock auth context and dependencies via simple parameters
- **Rationale**: Enables fast feedback loop and isolated regression detection

## Technical Approach

### Phase 1: Infrastructure & Shared Utilities

**Objective**: Set up the modular structure and shared utilities foundation

**Components**:
- Update `packages/server/src/handler.ts` to implement the router dispatch pattern
  - Add sequential path-based dispatcher: `/api/auth/*` → auth router, `/api/runners/*` → runners router, etc.
  - Maintain auth validation in handler.ts before delegating to routers
  - Ensure 404 handling for unmatched paths
- Create `packages/server/src/routes/utils.ts` with extracted utilities
  - `parseJsonArray(input: unknown): unknown[]` — safely parse JSON arrays from request bodies
  - `pickRunnerIdLeastLoaded(): string` — select runner with fewest active sessions
  - `pickRunnerIdForCwd(cwd: string): string` — select runner matching current working directory
  - `mintEphemeralApiKey(userId: string, ttl: number): string` — generate temporary API keys
- Create `packages/server/src/routes/types.ts` if shared types are needed (e.g., common request/response shapes)
- Update all router imports to reference the new file locations

**Key Considerations**:
- Maintain existing auth checks (`requireSession`, `validateApiKey`) in handler.ts
- Preserve all existing error handling and logging patterns
- Verify no performance regression in dispatcher logic

**Success Criteria**:
- [ ] Handler.ts dispatches all paths to appropriate routers
- [ ] Utilities are extracted and all callers updated
- [ ] All existing tests still pass
- [ ] TypeScript strict mode compliance maintained

### Phase 2: Extract Simple Routers (Auth & Settings)

**Objective**: Create auth and settings routers as foundational examples

**Components**:
- **`packages/server/src/routes/auth.ts`** (estimated 80-120 lines)
  - `POST /api/register` — new user registration
  - `GET /api/signup-status` — check if registrations are allowed
  - Import: auth.ts, security.ts, validation.ts
  - Export: `handleAuthRoute(req: Request, url: URL): Promise<Response | undefined>`
  
- **`packages/server/src/routes/settings.ts`** (estimated 40-60 lines)
  - `GET /api/settings/hidden-models` — fetch user's hidden model list
  - `PUT /api/settings/hidden-models` — update hidden models
  - Import: user-hidden-models.ts
  - Export: `handleSettingsRoute(req: Request, url: URL): Promise<Response | undefined>`

**Testing**:
- Unit tests for path matching logic
- Mock auth context and DB for response validation
- Test both happy path and error cases (invalid input, auth failure)

**Key Considerations**:
- These routers have minimal external dependencies (auth, DB)
- Serve as templates for more complex routers
- Test these first to validate the router pattern before scaling

**Success Criteria**:
- [ ] Auth router extracts register and signup-status endpoints
- [ ] Settings router isolates hidden-models CRUD
- [ ] Both routers have ≥ 90% test coverage
- [ ] No behavioral changes from original monolith
- [ ] Router files ≤ 100 lines each

### Phase 3: Extract Complex Runners Router

**Objective**: Refactor the largest and most complex endpoint group

**Components**:
- **`packages/server/src/routes/runners.ts`** (estimated 350-450 lines, may split if needed)
  - `GET /api/runners` — list all runners with status
  - `POST /api/runners/spawn` — spawn new session on least-loaded runner
  - `POST /api/runners/restart` — restart a runner
  - `POST /api/runners/stop` — stop a runner
  - `POST /api/runners/terminal` — create terminal for session
  - `GET /api/runners/:id/recent-folders` — list recent project folders
  - Runner skill management: list, get, create, update, delete skills
  - File operations: list, search, read files on runner
  - Git operations: status, diff for repositories
  - Import: ws/sio-registry.ts, runner-recent-folders.ts, utils.ts (for picker functions), auth.ts, DB models
  - Export: `handleRunnersRoute(req: Request, url: URL): Promise<Response | undefined>`

**Sub-components (if ≥ 500 lines)**:
- Could split into: runners-core.ts (spawn, list, restart, stop), runners-skills.ts (skill CRUD), runners-files.ts (file ops), runners-git.ts (git ops)
- Only split if needed for size constraint

**Testing**:
- Mock WebSocket registry and runner state
- Test spawn logic with least-loaded picker
- Test error handling (no available runner, invalid session ID)
- Test skill CRUD operations
- Test file and git operations with mocked system calls

**Key Considerations**:
- Most complex router with highest impact on feature velocity
- WebSocket integration through sio-registry.ts
- Careful with mock data for runner selection logic
- File system operations need careful mocking for test isolation

**Success Criteria**:
- [ ] All runner endpoints moved to dedicated router
- [ ] ≥ 85% test coverage (complex logic warrants thorough testing)
- [ ] No functional regression in spawn, restart, stop operations
- [ ] File and git operations maintain isolation and security checks
- [ ] Router file ≤ 500 lines (split if necessary)

### Phase 4: Extract Sessions & Attachments Routers

**Objective**: Refactor session management and file attachment endpoints

**Components**:
- **`packages/server/src/routes/sessions.ts`** (estimated 80-120 lines)
  - `GET /api/sessions` — list all user sessions with metadata
  - `GET /api/sessions/pinned` — list pinned sessions (prioritized view)
  - `PUT /api/sessions/:id/pin` — add session to user's pinned list
  - `DELETE /api/sessions/:id/pin` — remove from pinned list
  - Import: sessions/store.ts
  - Export: `handleSessionsRoute(req: Request, url: URL): Promise<Response | undefined>`

- **`packages/server/src/routes/attachments.ts`** (estimated 100-150 lines)
  - `POST /api/sessions/:id/attachments` — upload file attachment for session
  - `GET /api/attachments/:id` — download attachment by ID
  - Import: attachments/store.ts, security.ts (for permission checks)
  - Export: `handleAttachmentsRoute(req: Request, url: URL): Promise<Response | undefined>`

**Testing**:
- Mock session storage and attachment store
- Test list operations with various filter/sort options
- Test pin/unpin idempotency
- Test file upload (size limits, type restrictions, storage)
- Test file download (auth, existence checks, streaming)

**Key Considerations**:
- Sessions and attachments are logically related (attachments belong to sessions)
- Attachment uploads need careful size limit handling
- Download streaming must maintain compatibility with existing behavior

**Success Criteria**:
- [ ] Sessions router handles all session CRUD and pinning
- [ ] Attachments router manages file upload/download lifecycle
- [ ] ≥ 85% test coverage
- [ ] File upload size limits enforced
- [ ] Download streaming works without buffering entire file in memory
- [ ] Each router ≤ 150 lines

### Phase 5: Extract Chat & Push Routers

**Objective**: Refactor service-oriented and event-driven endpoints

**Components**:
- **`packages/server/src/routes/chat.ts`** (estimated 80-120 lines)
  - `POST /api/chat` — send chat message (with model inference, tool calling, etc.)
  - `GET /api/models` — list available AI models and their metadata
  - Import: auth.ts (for user identity), models API, tool registry
  - Export: `handleChatRoute(req: Request, url: URL): Promise<Response | undefined>`

- **`packages/server/src/routes/push.ts`** (estimated 150-200 lines)
  - `GET /api/push/vapid-public-key` — get push notification public key
  - `POST /api/push/subscribe` — register device for push notifications
  - `POST /api/push/unsubscribe` — unregister device from push
  - `GET /api/push/subscriptions` — list active subscriptions for user
  - `PUT /api/push/events` — configure which events trigger push
  - `POST /api/push/answer` — answer user question from push notification prompt
  - Import: push.ts (notification logic), auth.ts
  - Export: `handlePushRoute(req: Request, url: URL): Promise<Response | undefined>`

**Testing**:
- Chat: Mock models API, verify request forwarding and response handling
- Push: Mock VAPID keys and subscription store, test subscription lifecycle

**Key Considerations**:
- Chat has external dependencies (models API) that must be mocked in tests
- Push is well-isolated from other domains
- Both have clear request/response contracts

**Success Criteria**:
- [ ] Chat router delegates to models API correctly
- [ ] Push router manages subscription lifecycle without state leaks
- [ ] ≥ 80% test coverage for both
- [ ] No changes to chat/push external contracts
- [ ] Each router ≤ 200 lines

### Phase 6: Comprehensive Testing Suite

**Objective**: Ensure ≥ 80% code coverage and verify backward compatibility

**Components**:
- **Unit tests for each router**
  - Co-located test files: `routes/auth.test.ts`, `routes/runners.test.ts`, etc.
  - Test path matching, request validation, response schemas
  - Mock all external dependencies
  - Target ≥ 85% coverage per router

- **Integration tests**
  - Test router chaining in dispatcher
  - Verify 404 handling for unmapped paths
  - Test auth middleware interaction with routers

- **Regression tests**
  - Run existing API test suite against new routers
  - Verify all 50+ endpoints return identical responses
  - Load tests for performance regression detection (latency ≤ 5% variance)

- **Type safety verification**
  - Run `bun run typecheck` to ensure strict mode compliance
  - Verify no ESLint regressions

**Testing Approach**:
```typescript
// Example test pattern for routers
test("GET /api/runners returns list", async () => {
  const req = new Request("http://localhost/api/runners", { method: "GET" });
  const url = new URL(req.url);
  const res = await handleRunnersRoute(req, url);
  expect(res?.status).toBe(200);
  const data = await res?.json();
  expect(Array.isArray(data?.runners)).toBe(true);
});
```

**Key Considerations**:
- Testing must be CI-portable (no system dependencies, reproducible)
- Mocking must be comprehensive but minimal
- Regression tests validate that external behavior is unchanged

**Success Criteria**:
- [ ] ≥ 80% code coverage across all routers
- [ ] All unit tests pass in CI environment
- [ ] Integration tests pass (router dispatch, 404 handling)
- [ ] Regression tests confirm identical endpoint behavior
- [ ] TypeScript strict mode fully compliant
- [ ] No new ESLint warnings

### Phase 7: Verification & Documentation

**Objective**: Validate backward compatibility and provide developer guidance

**Components**:
- **Router structure documentation**
  - Add README to `routes/` with directory map and endpoint listing
  - Document router signature pattern for future contributors
  - Provide example of adding a new endpoint to each router type

- **Backward compatibility verification**
  - Run full test suite
  - Performance profile: measure latency before/after (expect ≤ 5% change)
  - Verify all HTTP status codes are unchanged

- **Code organization audit**
  - Verify no router ≥ 500 lines
  - Verify shared utilities are properly extracted
  - Check for circular dependencies
  - Audit imports for clarity and minimal coupling

**Key Considerations**:
- Documentation helps onboarding and future maintenance
- Backward compatibility verification must be rigorous
- Code organization must support ≤ 15 minute onboarding for new endpoints

**Success Criteria**:
- [ ] `routes/README.md` documents all routers and their endpoints
- [ ] Router pattern documentation clear for new contributions
- [ ] All tests pass (unit, integration, regression)
- [ ] Performance latency ≤ 5% difference from baseline
- [ ] All HTTP status codes match original implementation
- [ ] No router file ≥ 500 lines
- [ ] No circular dependencies between routers
- [ ] Import statements show clear, minimal dependency chains

## Implementation Strategy

### Development Phases

1. **Foundation (Phase 1)**: Infrastructure and utils extraction (1 task)
   - Set up dispatcher, extract shared utilities
   - Validate test suite still passes

2. **Simple Routers (Phase 2)**: Auth and settings (1 task)
   - Build out first routers as templates
   - Establish testing patterns

3. **Complex Router (Phase 3)**: Runners (1 task)
   - Tackle most complex endpoint group
   - Validate split-if-needed logic
   - High-quality testing

4. **Mid-Range Routers (Phase 4)**: Sessions and attachments (1 task)
   - Parallel pattern application
   - File handling patterns

5. **Service Routers (Phase 5)**: Chat and push (1 task)
   - External service integration patterns
   - Well-isolated testing

6. **Quality Gates (Phase 6)**: Testing and verification (1 task)
   - Comprehensive coverage
   - Regression validation
   - Performance profiling

7. **Documentation (Phase 7)**: Developer guidance (1 task)
   - Router documentation
   - Onboarding examples
   - Code organization audit

### Risk Mitigation

- **Incremental refactoring**: Start with simple routers, build confidence before tackling runners
- **Test-driven**: Maintain test suite throughout; never have broken builds
- **Rollback readiness**: Keep original `api.ts` reference until all routers verified
- **Pair programming**: Complex routers (runners) should have review/pair sessions
- **Performance monitoring**: Use load tests to catch latency regressions early

### Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Test Coverage | ≥ 80% | `bun run test --coverage` |
| Backward Compatibility | 100% | Regression test suite passes |
| Code Organization | All routers ≤ 500 lines | `wc -l routes/*.ts` |
| Performance | ≤ 5% latency change | Load test before/after |
| TypeScript Compliance | 0 strict errors | `bun run typecheck` |
| Developer Velocity | ≤ 15 min to add endpoint | Timed walkthrough |

## Task Breakdown Preview

1. **Refactor infrastructure & utilities** - Update handler.ts dispatcher, extract routes/utils.ts, routes/types.ts
2. **Extract auth & settings routers** - Create auth.ts and settings.ts with tests
3. **Extract runners router** - Build complex runners.ts with comprehensive testing
4. **Extract sessions & attachments routers** - Create sessions.ts and attachments.ts
5. **Extract chat & push routers** - Build chat.ts and push.ts with external service mocking
6. **Comprehensive testing & validation** - Unit/integration/regression tests, TypeScript checks, coverage targets
7. **Documentation & code audit** - README, pattern examples, final verification

## Dependencies

### Internal Dependencies

- `packages/server/src/auth.ts` — User identity, API key validation
- `packages/server/src/middleware.ts` — `requireSession()`, `validateApiKey()` middleware
- `packages/server/src/handler.ts` — Central dispatcher (modified for router delegation)
- `packages/server/src/security.ts` — Rate limiting, validation helpers
- `packages/server/src/validation.ts` — Input validation utilities
- `packages/server/src/ws/sio-registry.ts` — WebSocket registry for runners and sessions
- `packages/server/src/sessions/store.ts` — Session persistence
- `packages/server/src/attachments/store.ts` — File attachment storage
- `packages/server/src/push.ts` — Push notification logic
- `packages/server/src/runner-recent-folders.ts` — Recent folder tracking
- `packages/server/src/user-hidden-models.ts` — User preferences

### Prerequisite Work

- None — refactoring is isolated and can proceed in parallel with other development

### Blocked By

- None — can start immediately after epic decomposition

## Success Criteria (Technical)

1. **Modular Organization**: Seven clean router modules organized by API domain
2. **Code Size**: No single router exceeds 500 lines; average router 150-200 lines
3. **Test Coverage**: ≥ 80% code coverage; ≥ 85% for complex routers (runners)
4. **Backward Compatibility**: 100% — all 50+ endpoints remain at original paths with identical behavior
5. **Performance**: Request latency ≤ 5% variance from baseline (typically improvement)
6. **Type Safety**: Zero TypeScript strict mode violations; no ESLint regressions
7. **Testability**: Each router is independently testable; mock setup is straightforward
8. **Developer Experience**: New endpoints can be added in ≤ 15 minutes to the correct router

## Tasks Created

✅ **Task Breakdown** (7 tasks total):

- [ ] **001.md** - Refactor infrastructure & utilities (parallel: false, depends_on: [])
- [ ] **002.md** - Extract auth & settings routers (parallel: false, depends_on: [001])
- [ ] **003.md** - Extract runners router (parallel: false, depends_on: [002])
- [ ] **004.md** - Extract sessions & attachments routers (parallel: true, depends_on: [001])
- [ ] **005.md** - Extract chat & push routers (parallel: true, depends_on: [001])
- [ ] **006.md** - Comprehensive testing & validation (parallel: false, depends_on: [002, 003, 004, 005])
- [ ] **007.md** - Documentation & code audit (parallel: false, depends_on: [006])

**Execution Strategy:**
- **Phase 1 (Foundation)**: Task 001 - Infrastructure setup (critical path, enables all others)
- **Phase 2 (Pattern)**: Task 002 - Auth & settings routers establish pattern
- **Phase 3 (Critical Path)**: Task 003 - Runners router (most complex, highest impact)
- **Phase 4 (Parallel Work)**: Tasks 004, 005 - Sessions/attachments and chat/push run in parallel
- **Phase 5 (Quality Gate)**: Task 006 - Comprehensive testing & validation
- **Phase 6 (Finalization)**: Task 007 - Documentation & code audit

**Effort Breakdown:**
- Task 001: M (6-8 hours) — Infrastructure setup
- Task 002: S (4-5 hours) — Simple routers as templates
- Task 003: L (12-16 hours) — Complex runners router
- Task 004: M (8-10 hours) — Session & attachment routers (parallel)
- Task 005: M (8-10 hours) — Chat & push routers (parallel)
- Task 006: M (8-10 hours) — Testing & validation
- Task 007: S (4-6 hours) — Documentation & audit

**Total Estimated Effort**: ~50-65 hours (7 tasks, some parallelized)
**Critical Path Duration**: ~40-50 hours (sequential bottleneck: 001→002→003→006→007)
**Parallel Capacity**: 2-3 developers recommended (Tasks 004, 005 can run concurrently with Task 003)

## Estimated Effort

- **Total scope**: ~7 tasks across infrastructure, router extraction, testing, and documentation
- **Estimated duration**: 3-5 sprints (depending on parallelization and team size)
- **Critical path**: Infrastructure → Auth/Settings → Runners → Testing → Documentation
- **Team capacity**: Can be parallelized across 2-3 developers
  - Developer 1: Tasks 001, 002, 003 (infrastructure → runners)
  - Developer 2: Task 004 (sessions/attachments, parallel with 003)
  - Developer 3: Task 005 (chat/push, parallel with 003)
  - All: Task 006 (testing), Task 007 (documentation)

## Open Questions for Team Alignment

Before starting execution:

1. **Scope confirmation**: Is the 7-router breakdown (auth, runners, sessions, attachments, chat, push, settings) correct?
2. **Execution strategy**: Proceed with sequential then parallel approach (001→002→003 then 004,005 parallel)?
3. **Testing depth**: Maintain ≥ 80% coverage as specified, or adjust target?
4. **Timeline**: Is 3-5 sprints acceptable for this refactoring?
5. **Team assignment**: Can we assign 2-3 developers for parallel execution?
6. **API freeze**: Should we pause other API changes during refactoring?
7. **Rollback plan**: Keep original api.ts as reference until verification complete?
