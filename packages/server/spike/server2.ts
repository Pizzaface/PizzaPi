/**
 * Spike Server 2 — port 3101
 * Tests cross-server fan-out via Redis adapter.
 * A client connected here should receive events emitted by a client on server1.
 */
import { createServer } from "node:http";
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";

const PORT = Number(process.env.PORT ?? 3101);
const REDIS_URL = process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379";

const pubClient = createClient({ url: REDIS_URL });
const subClient = pubClient.duplicate();

await Promise.all([pubClient.connect(), subClient.connect()]);
console.log(`[server2] Redis connected (${REDIS_URL})`);

const httpServer = createServer();

const io = new Server(httpServer, {
  adapter: createAdapter(pubClient, subClient),
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
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
  next();
});

relay.on("connection", (socket) => {
  console.log(`[server2/relay] connect  ${socket.id}`);

  socket.on("join_session", (sessionId: string) => {
    socket.join(`session:${sessionId}`);
    console.log(`[server2/relay] ${socket.id} joined session:${sessionId}`);
  });

  // Echo received cross-server events so the test client can verify delivery
  socket.on("agent_event", (payload) => {
    console.log(`[server2/relay] received agent_event (cross-server):`, payload);
    socket.emit("cross_server_echo", payload);
  });

  socket.on("disconnect", () => {
    console.log(`[server2/relay] disconnect ${socket.id}`);
  });
});

// ── /viewer namespace ─────────────────────────────────────────────────────────
const viewer = io.of("/viewer");

viewer.on("connection", (socket) => {
  console.log(`[server2/viewer] connect  ${socket.id}`);

  socket.on("subscribe", (sessionId: string) => {
    socket.join(`session:${sessionId}`);
    socket.emit("subscribed", { sessionId });
  });

  // Log when viewer receives cross-server broadcast
  socket.on("agent_event", (payload) => {
    console.log(`[server2/viewer] received agent_event via Redis broadcast:`, payload);
    socket.emit("cross_server_echo", payload);
  });

  socket.on("disconnect", () => {
    console.log(`[server2/viewer] disconnect ${socket.id}`);
  });
});

// ── /runner namespace ─────────────────────────────────────────────────────────
const runner = io.of("/runner");

runner.on("connection", (socket) => {
  console.log(`[server2/runner] connect  ${socket.id}`);
  socket.on("runner_ping", (_, ack) => {
    if (typeof ack === "function") ack({ pong: true, server: 2, ts: Date.now() });
  });
  socket.on("disconnect", () => {
    console.log(`[server2/runner] disconnect ${socket.id}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[server2] listening on http://localhost:${PORT}`);
});

process.on("SIGINT", async () => {
  console.log("[server2] shutting down...");
  await io.close();
  await pubClient.quit();
  await subClient.quit();
  process.exit(0);
});
