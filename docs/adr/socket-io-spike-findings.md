# Socket.IO spike findings

Conclusions preserved from `packages/server/spike/FINDINGS.md` (spike deleted 2026-09; full data lived there).

- **Decision: GO** — Socket.IO v4.8.3 is fully compatible with Bun; all 15 acceptance criteria passed (2026-02-22, issue PizzaPi-b8h.1).
- Attach Socket.IO via `node:http.createServer()`, **not** `Bun.serve()` — the `Server` constructor does not accept a Bun instance. Migrating `packages/server/src/index.ts` means switching the HTTP bootstrap to `node:http` and adapting REST routing.
- Bun auto-loads `packages/server/.env` (`PORT=3001`); start spike/extra servers with an explicit `PORT=XXXX` override.
- `@socket.io/redis-adapter` needs two separate pub/sub Redis clients (`subClient = pubClient.duplicate()`); the server already uses `redis` v4 so this slots in cleanly.
- Cross-server fan-out (CLI on server A → viewer on server B) and namespace isolation (`/relay`, `/runner`, `/viewer`) verified working; ack latency avg ~1.3ms.
- Connection State Recovery reconnects within 8s; `socket.recovered` is only `false` after a clean `engine.close()` — genuine network drops recover within the 2-minute window.
- Package versions validated: `socket.io` 4.8.3, `socket.io-client` 4.8.3, `@socket.io/redis-adapter` 8.3.0.