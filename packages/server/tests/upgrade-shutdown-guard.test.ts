/**
 * SIGTERM drain-window upgrade guard (index.ts upgrade interception).
 *
 * Reproduces the production wiring — node:http + Socket.IO + the
 * interception-with-guard pattern — because the bug only manifests across
 * that boundary: during graceful shutdown `io.close()` closes the engine's
 * WebSocketServer first while the HTTP server keeps accepting upgrades for
 * up to the drain period. Bun's built-in `ws` shim then throws from
 * `abortHandshake` (uncaughtException → the whole relay goes down) when an
 * upgrade reaches the closed server (oven-sh/bun#39766). The guard destroys
 * the socket instead of delegating.
 *
 * Without the guard this suite's process dies with:
 *   TypeError: undefined is not an object (evaluating 'message')
 *     at abortHandshake (ws) at handleUpgrade (ws)
 * — the exact production crash from 2026-09-03.
 */

import http from "node:http";
import net from "node:net";
import { afterAll, describe, expect, test } from "bun:test";
import { Server as IOServer } from "socket.io";
import { isServerShuttingDown, resetServerShuttingDown, setServerShuttingDown } from "../src/health.js";

const stacks: Array<{ httpServer: http.Server; io: IOServer }> = [];

/** node:http + Socket.IO + index.ts's upgrade interception (with guard). */
async function makeStack(): Promise<{ port: () => number; io: IOServer }> {
    const httpServer = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("ok");
    });
    const io = new IOServer(httpServer, { transports: ["websocket", "polling"] });

    const existingUpgradeListeners = httpServer.listeners("upgrade").slice();
    httpServer.removeAllListeners("upgrade");
    httpServer.on("upgrade", (req, socket, head) => {
        if (isServerShuttingDown) {
            socket.destroy();
            return;
        }
        for (const listener of existingUpgradeListeners) {
            (listener as Function).call(httpServer, req, socket, head);
        }
    });

    stacks.push({ httpServer, io });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    return {
        io,
        port: () => (httpServer.address() as { port: number }).port,
    };
}

afterAll(async () => {
    for (const { httpServer } of stacks) {
        (httpServer as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        httpServer.close();
    }
    for (const { io } of stacks) io.close();
    resetServerShuttingDown();
});

function sendUpgrade(port: () => number, raw: string, opts?: { resolveOnHandshake?: boolean }): Promise<{ bytes: string; closed: boolean }> {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port(), "127.0.0.1", () => sock.write(raw));
        let bytes = "";
        sock.on("data", (d) => {
            bytes += d.toString();
            if (opts?.resolveOnHandshake && bytes.includes("\r\n\r\n")) {
                sock.destroy();
                resolve({ bytes, closed: true });
            }
        });
        sock.on("close", () => resolve({ bytes, closed: true }));
        sock.on("error", (err) => {
            // ECONNRESET on destroy() — the guard's intended outcome.
            if ((err as NodeJS.ErrnoException).code === "ECONNRESET") resolve({ bytes, closed: true });
            else reject(err);
        });
        setTimeout(() => {
            sock.destroy();
            resolve({ bytes, closed: sock.destroyed });
        }, 2500);
    });
}

const VALID_UPGRADE =
    "GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: localhost\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";

describe("upgrade interception: SIGTERM drain window", () => {
    test("upgrade during shutdown is destroyed, never delegated to the closed ws engine", async () => {
        const stack = await makeStack();
        // The shutdown sequence: flag first (index.ts onShutdownSignal), then
        // io.close() closes the engine's WebSocketServer while the HTTP server
        // drains. Simulate the window the crash lives in.
        setServerShuttingDown();
        (stack.io.engine as unknown as { ws: { close: () => void } }).ws.close();
        await new Promise((r) => setTimeout(r, 50));

        const { bytes, closed } = await sendUpgrade(stack.port, VALID_UPGRADE);
        // If the guard regressed, the uncaughtException from Bun's ws shim
        // kills this test process outright — no assertion needed for that.
        expect(closed).toBe(true);
        expect(bytes).not.toContain("HTTP/"); // destroyed before any response
        resetServerShuttingDown();
    });

    test("normal upgrades still reach Socket.IO when the server is not shutting down", async () => {
        const stack = await makeStack();
        const { bytes } = await sendUpgrade(stack.port, VALID_UPGRADE, { resolveOnHandshake: true });
        expect(bytes).toContain("HTTP/1.1 101");
    });
});