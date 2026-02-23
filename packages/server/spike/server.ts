/**
 * Spike Server 1 — port 3100
 * Tests: Socket.IO + Bun.serve, Redis adapter, namespaces, connection state recovery
 */
import { createServer } from "node:http";
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";

const PORT = Number(process.env.PORT ?? 3100);
const REDIS_URL = process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379";

// --- Redis clients (separate pub/sub connections as required by redis-adapter) ---
const pubClient = createClient({ url: REDIS_URL });
const subClient = pubClient.duplicate();

await Promise.all([pubClient.connect(), subClient.connect()]);
console.log(`[server1] Redis connected (${REDIS_URL})`);

// --- HTTP server (Bun node:http compat) ---
const httpServer = createServer();

// --- Socket.IO server ---
const io = new Server(httpServer, {
  adapter: createAdapter(pubClient, subClient),
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  },
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
});

// ── /relay namespace ──────────────────────────────────────────────────────────
const relay = io.of("/relay");

relay.use((socket, next) => {
  const apiKey = socket.handshake.auth.apiKey;
  if (!apiKey) return next(new Error("missing apiKey"));
  (socket.data as Record<string, unknown>).apiKey = apiKey;
  next();
});

relay.on("connection", (socket) => {
  const recovered = socket.recovered;
  console.log(`[server1/relay] connect  ${socket.id} recovered=${recovered}`);

  socket.on("agent_event", (payload, ack) => {
    // Fan-out to viewers — broadcast into the /viewer namespace room via Redis adapter
    // This is the real PizzaPi pattern: CLI connects to /relay, browsers to /viewer
    const sessionId = (socket.data as Record<string, unknown>).sessionId as string;
    if (sessionId) {
      viewer.to(`session:${sessionId}`).emit("agent_event", payload);
    }
    if (typeof ack === "function") ack({ ok: true });
  });

  socket.on("join_session", (sessionId: string) => {
    socket.join(`session:${sessionId}`);
    (socket.data as Record<string, unknown>).sessionId = sessionId;
    console.log(`[server1/relay] ${socket.id} joined session:${sessionId}`);
  });

  socket.on("disconnect", (reason) => {
    console.log(`[server1/relay] disconnect ${socket.id} reason=${reason}`);
  });
});

// ── /viewer namespace ─────────────────────────────────────────────────────────
const viewer = io.of("/viewer");

viewer.on("connection", (socket) => {
  console.log(`[server1/viewer] connect  ${socket.id}`);

  socket.on("subscribe", (sessionId: string) => {
    socket.join(`session:${sessionId}`);
    socket.emit("subscribed", { sessionId });
    console.log(`[server1/viewer] ${socket.id} subscribed to session:${sessionId}`);
  });

  socket.on("disconnect", () => {
    console.log(`[server1/viewer] disconnect ${socket.id}`);
  });
});

// ── /runner namespace ─────────────────────────────────────────────────────────
const runner = io.of("/runner");

runner.on("connection", (socket) => {
  const runnerId = socket.handshake.auth.runnerId ?? "unknown";
  console.log(`[server1/runner] connect  ${socket.id} runnerId=${runnerId}`);

  socket.on("runner_ping", (_, ack) => {
    if (typeof ack === "function") ack({ pong: true, server: 1, ts: Date.now() });
  });

  socket.on("disconnect", () => {
    console.log(`[server1/runner] disconnect ${socket.id}`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[server1] listening on http://localhost:${PORT}`);
  console.log(`[server1] namespaces: /relay  /viewer  /runner`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("[server1] shutting down...");
  await io.close();
  await pubClient.quit();
  await subClient.quit();
  process.exit(0);
});
