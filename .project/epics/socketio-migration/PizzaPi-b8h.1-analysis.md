# Analysis: PizzaPi-b8h.1 — Bun + Socket.IO Compatibility Spike

## Scope

Single-stream task. Create a minimal `spike/socketio/` directory to validate Socket.IO v4.8+ works under Bun for all PizzaPi use cases before committing to the migration.

## Stream A: Full Spike (single agent)

### Files to Create
- `spike/socketio/server.ts` — Bun.serve + Socket.IO server with Redis adapter, 3 namespaces (`/relay`, `/viewer`, `/runner`)
- `spike/socketio/client-bun.ts` — Bun-based socket.io-client (WS-only transport, simulates CLI/runner)
- `spike/socketio/client-browser.html` — Simple HTML page with socket.io-client (default transport)
- `spike/socketio/server2.ts` — Second server instance on different port (tests cross-server fan-out via Redis adapter)
- `spike/socketio/run-spike.sh` — Script to start servers, run clients, verify all criteria
- `spike/socketio/FINDINGS.md` — Written summary of results and go/no-go decision

### What to Validate
1. `new Server()` attaches to Bun.serve via `node:http` createServer compat
2. socket.io-client connects from Bun runtime with `transports: ["websocket"]`
3. socket.io-client connects from browser (serve the HTML page)
4. `@socket.io/redis-adapter` with `createAdapter()` on `PIZZAPI_REDIS_URL` (default `redis://localhost:6379`)
5. Cross-server broadcast: emit on server1, receive on client connected to server2
6. Connection State Recovery: enable `connectionStateRecovery`, test disconnect/reconnect within 2 min
7. Namespace isolation: events on `/relay` don't leak to `/viewer`
8. Round-trip latency measurement

### Key Dependencies
- `socket.io` (server)
- `socket.io-client` (client)
- `@socket.io/redis-adapter` (adapter)
- Redis running locally

### Risk Areas
- Bun's `node:http` compatibility — Socket.IO uses `http.createServer()` internally
- engine.io transport negotiation in Bun vs Node
- Redis pub/sub connection handling under Bun

## Estimated Effort
- 4 hours, single stream
- No file conflicts possible (new `spike/` directory only)
