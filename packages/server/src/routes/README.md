# API Routes

Modular domain routers for PizzaPi's REST API. Each router is a pure async
function that returns `Response | undefined` — the dispatcher in `index.ts`
tries them sequentially.

## Directory Structure

```
routes/
├── index.ts          Central dispatcher — chains routers, handles /health & /api/version
├── types.ts          Shared RouteHandler type
├── utils.ts          Shared utilities (parseJsonArray, runner pickers, ephemeral API keys)
├── auth.ts           POST /api/register, GET /api/signup-status
├── runners.ts        /api/runners/* — spawn, restart, stop, terminal, skills, files, git
├── sessions.ts       /api/sessions/* — list, pin/unpin
├── attachments.ts    Upload (POST /api/sessions/:id/attachments), download (GET /api/attachments/:id)
├── chat.ts           POST /api/chat, GET /api/models
├── push.ts           /api/push/* — VAPID key, subscribe, unsubscribe, events
├── settings.ts       /api/settings/hidden-models — GET & PUT
├── index.test.ts     Dispatcher tests (health, 404, router delegation)
└── utils.test.ts     parseJsonArray unit tests
```

## Router Signature

Every router exports a `RouteHandler`:

```typescript
type RouteHandler = (req: Request, url: URL) => Promise<Response | undefined>;
```

- Return a `Response` when the path matches.
- Return `undefined` to pass to the next router.

## Adding a New Endpoint

1. Find the appropriate router file (or create a new one).
2. Add your path match inside the exported handler function.
3. If creating a new router, register it in `index.ts`'s `routers` array.
4. Add tests in the co-located `.test.ts` file.
5. Run `bun run typecheck && bun run test`.

## Design Rules

- **No router exceeds 500 lines** — split by sub-feature if needed.
- **Auth checks stay in handler.ts** — better-auth's `/api/auth/*` routes are
  handled before the dispatcher runs.
- **Routers are stateless** — all dependencies are imported, no instance state.
- **No circular dependencies** between routers.

## Endpoint Map

| Method | Path | Router | Auth |
|--------|------|--------|------|
| GET | `/health` | index.ts | No |
| GET | `/api/version` | index.ts | No |
| GET | `/api/signup-status` | auth.ts | No |
| POST | `/api/register` | auth.ts | No (rate-limited) |
| GET | `/api/runners` | runners.ts | Session |
| POST | `/api/runners/spawn` | runners.ts | Session or API key |
| POST | `/api/runners/restart` | runners.ts | Session |
| POST | `/api/runners/stop` | runners.ts | Session |
| POST | `/api/runners/terminal` | runners.ts | Session |
| GET | `/api/runners/:id/recent-folders` | runners.ts | Session |
| GET | `/api/runners/:id/skills` | runners.ts | Session |
| GET | `/api/runners/:id/skills/:name` | runners.ts | Session |
| POST | `/api/runners/:id/skills` | runners.ts | Session |
| PUT | `/api/runners/:id/skills/:name` | runners.ts | Session |
| DELETE | `/api/runners/:id/skills/:name` | runners.ts | Session |
| POST | `/api/runners/:id/files` | runners.ts | Session |
| POST | `/api/runners/:id/search-files` | runners.ts | Session |
| POST | `/api/runners/:id/read-file` | runners.ts | Session |
| POST | `/api/runners/:id/git-status` | runners.ts | Session |
| POST | `/api/runners/:id/git-diff` | runners.ts | Session |
| GET | `/api/sessions` | sessions.ts | Session |
| GET | `/api/sessions/pinned` | sessions.ts | Session |
| PUT | `/api/sessions/:id/pin` | sessions.ts | Session |
| DELETE | `/api/sessions/:id/pin` | sessions.ts | Session |
| POST | `/api/sessions/:id/attachments` | attachments.ts | Session |
| GET | `/api/attachments/:id` | attachments.ts | Session or API key |
| POST | `/api/chat` | chat.ts | Session |
| GET | `/api/models` | chat.ts | Session |
| GET | `/api/push/vapid-public-key` | push.ts | No |
| POST | `/api/push/subscribe` | push.ts | Session |
| POST | `/api/push/unsubscribe` | push.ts | Session |
| GET | `/api/push/subscriptions` | push.ts | Session |
| PUT | `/api/push/events` | push.ts | Session |
| POST | `/api/push/answer` | push.ts | Session |
| GET | `/api/settings/hidden-models` | settings.ts | Session |
| PUT | `/api/settings/hidden-models` | settings.ts | Session |
