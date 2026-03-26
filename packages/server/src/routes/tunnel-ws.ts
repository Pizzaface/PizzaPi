/**
 * Tunnel WebSocket upgrade handler — /api/tunnel/:sessionId/:port/*
 *
 * Intercepts WebSocket upgrade requests on tunnel paths and bridges them
 * to the runner daemon via Socket.IO events (WS-over-Socket.IO framing).
 *
 * Flow:
 *   1. Viewer sends HTTP upgrade request to /api/tunnel/{sessionId}/{port}/path
 *   2. Server authenticates, looks up the runner, sends tunnel_ws_open to runner
 *   3. Runner opens a real WebSocket to ws://127.0.0.1:{port}/path
 *   4. Runner confirms with tunnel_ws_opened → server completes WS handshake with viewer
 *   5. Frames are bridged bidirectionally via tunnel_ws_data events
 *   6. Either side can close via tunnel_ws_close
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { getAuth } from "../auth.js";
import { getSession } from "../ws/sio-state.js";
import { getLocalRunnerSocket } from "../ws/sio-registry.js";
import type { Socket } from "socket.io";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("tunnel-ws");

/** Pattern: /api/tunnel/:sessionId/:port/<rest> */
const TUNNEL_PATH_RE = /^\/api\/tunnel\/([^/]+)\/(\d+)(\/.*)?$/;

/** Hop-by-hop headers to strip before forwarding to runner. */
const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    "host",
]);

/**
 * Pending WebSocket tunnel connections awaiting runner confirmation.
 * Maps tunnelWsId → { socket, req, head, timeout }.
 */
interface PendingTunnelWs {
    rawSocket: Duplex;
    req: IncomingMessage;
    head: Buffer;
    wsKey: string;
    runnerId: string;
    timer: ReturnType<typeof setTimeout>;
}

const pendingTunnelWs = new Map<string, PendingTunnelWs>();

/**
 * Active WebSocket tunnel connections (handshake completed).
 * Maps tunnelWsId → raw TCP socket.
 */
const activeTunnelWs = new Map<string, Duplex>();

/** Reverse map: runnerId → Set of tunnelWsIds for cleanup on disconnect. */
const runnerTunnelWsIds = new Map<string, Set<string>>();

/**
 * Handle an HTTP upgrade request that might be a tunnel WebSocket.
 * Returns true if the request was handled (tunnel path), false if Socket.IO
 * or other handlers should process it.
 */
export function handleTunnelWsUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
): boolean {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];
    const match = pathname.match(TUNNEL_PATH_RE);
    if (!match) return false;

    // This is a tunnel path — we handle it (async, but return true synchronously).
    // The catch handles any unexpected errors (e.g. auth library throws synchronously
    // after an await point) so the rejected promise never becomes unhandled.
    handleUpgradeAsync(req, socket, head, match, url).catch((err) => {
        log.error("Unexpected error in upgrade handler:", err);
        if (!socket.destroyed) {
            rejectUpgrade(socket, 500, "Internal Server Error");
        }
    });
    return true;
}

async function handleUpgradeAsync(
    req: IncomingMessage,
    rawSocket: Duplex,
    head: Buffer,
    match: RegExpMatchArray,
    fullUrl: string,
): Promise<void> {
    let sessionId: string;
    try {
        sessionId = decodeURIComponent(match[1]);
    } catch {
        rejectUpgrade(rawSocket, 400, "Bad Request");
        return;
    }
    const port = parseInt(match[2], 10);
    const proxyPath = match[3] ?? "/";

    // Reconstruct query string, stripping auth query params (apiKey) so they
    // are not forwarded to the local service — SSRF auth-leakage vector.
    let pathWithQuery: string;
    const qIdx = fullUrl.indexOf("?");
    if (qIdx >= 0) {
        const qs = new URLSearchParams(fullUrl.slice(qIdx + 1));
        qs.delete("apiKey");
        const qsStr = qs.toString();
        pathWithQuery = qsStr ? `${proxyPath}?${qsStr}` : proxyPath;
    } else {
        pathWithQuery = proxyPath;
    }

    // ── Validate ──────────────────────────────────────────────────────────
    if (!sessionId || !Number.isFinite(port) || port < 1 || port > 65535) {
        rejectUpgrade(rawSocket, 400, "Bad Request");
        return;
    }

    // ── Authenticate ──────────────────────────────────────────────────────
    // WebSocket upgrade requests carry cookies but not the normal session
    // middleware path. Convert headers to a Request-like object for better-auth.
    const identity = await authenticateUpgrade(req);
    if (!identity) {
        rejectUpgrade(rawSocket, 401, "Unauthorized");
        return;
    }

    // ── Look up session and verify ownership ──────────────────────────────
    const sessionData = await getSession(sessionId);
    if (!sessionData) {
        rejectUpgrade(rawSocket, 404, "Session not found");
        return;
    }

    if (!sessionData.userId || sessionData.userId !== identity.userId) {
        rejectUpgrade(rawSocket, 403, "Forbidden");
        return;
    }

    const runnerId = sessionData.runnerId;
    if (!runnerId) {
        rejectUpgrade(rawSocket, 503, "Session has no runner");
        return;
    }

    const runnerSocket = getLocalRunnerSocket(runnerId);
    if (!runnerSocket) {
        rejectUpgrade(rawSocket, 503, "Runner not available");
        return;
    }

    // ── Extract Sec-WebSocket-Key for handshake ───────────────────────────
    const wsKey = req.headers["sec-websocket-key"];
    if (!wsKey) {
        rejectUpgrade(rawSocket, 400, "Missing Sec-WebSocket-Key");
        return;
    }

    const protocols = req.headers["sec-websocket-protocol"]
        ? req.headers["sec-websocket-protocol"].split(",").map((s) => s.trim())
        : undefined;

    // ── Build forwarded headers ───────────────────────────────────────────
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        // Strip auth headers (cookie, authorization, x-api-key) — SSRF auth-leakage vector
        if (lk === "cookie" || lk === "authorization" || lk === "x-api-key") continue;
        forwardHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
    }

    // ── Generate tunnel WS ID and register pending ────────────────────────
    const tunnelWsId = `tws-${sessionId}-${port}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const timer = setTimeout(() => {
        pendingTunnelWs.delete(tunnelWsId);
        removeTunnelWsFromRunner(runnerId, tunnelWsId);
        rejectUpgrade(rawSocket, 504, "Tunnel WebSocket open timed out");
    }, 10_000);

    pendingTunnelWs.set(tunnelWsId, {
        rawSocket,
        req,
        head,
        wsKey,
        runnerId,
        timer,
    });

    // Track for cleanup on runner disconnect
    if (!runnerTunnelWsIds.has(runnerId)) {
        runnerTunnelWsIds.set(runnerId, new Set());
    }
    runnerTunnelWsIds.get(runnerId)!.add(tunnelWsId);

    // Listen for socket close before handshake completes
    rawSocket.once("close", () => {
        const pending = pendingTunnelWs.get(tunnelWsId);
        if (pending) {
            clearTimeout(pending.timer);
            pendingTunnelWs.delete(tunnelWsId);
            removeTunnelWsFromRunner(runnerId, tunnelWsId);
            // Tell runner to close the local WS if it was opened
            (runnerSocket as Socket).emit("tunnel_ws_close" as any, { tunnelWsId });
        }
    });

    // ── Ask runner to open the local WebSocket ────────────────────────────
    (runnerSocket as Socket).emit("tunnel_ws_open" as any, {
        tunnelWsId,
        port,
        path: pathWithQuery,
        protocols,
        headers: forwardHeaders,
    });
}

// ── Runner event handlers (called from runner namespace) ──────────────────

/**
 * Runner confirms local WS connection is open — complete the viewer handshake.
 */
export function handleTunnelWsOpened(tunnelWsId: string, protocol?: string): void {
    const pending = pendingTunnelWs.get(tunnelWsId);
    if (!pending) return;

    clearTimeout(pending.timer);
    pendingTunnelWs.delete(tunnelWsId);

    const { rawSocket, wsKey, head, runnerId } = pending;

    // Complete the WebSocket handshake with the viewer
    const acceptKey = createHash("sha1")
        .update(wsKey + "258EAFA5-E914-47DA-95CA-C5AB5DC65340")
        .digest("base64");

    let upgradeResponse = "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n`;

    if (protocol) {
        upgradeResponse += `Sec-WebSocket-Protocol: ${protocol}\r\n`;
    }

    upgradeResponse += "\r\n";

    rawSocket.write(upgradeResponse);

    // If there was buffered data in head, process it
    if (head.length > 0) {
        handleIncomingWsFrame(tunnelWsId, runnerId, head);
    }

    // Store as active and wire up frame forwarding
    activeTunnelWs.set(tunnelWsId, rawSocket);

    rawSocket.on("data", (chunk: Buffer) => {
        handleIncomingWsFrame(tunnelWsId, runnerId, chunk);
    });

    rawSocket.on("close", () => {
        activeTunnelWs.delete(tunnelWsId);
        removeTunnelWsFromRunner(runnerId, tunnelWsId);
        // Tell runner the viewer disconnected
        const rs = getLocalRunnerSocket(runnerId);
        if (rs) {
            (rs as Socket).emit("tunnel_ws_close" as any, { tunnelWsId, code: 1001, reason: "viewer disconnected" });
        }
    });

    rawSocket.on("error", () => {
        activeTunnelWs.delete(tunnelWsId);
        removeTunnelWsFromRunner(runnerId, tunnelWsId);
        const rs = getLocalRunnerSocket(runnerId);
        if (rs) {
            (rs as Socket).emit("tunnel_ws_close" as any, { tunnelWsId, code: 1006, reason: "viewer connection error" });
        }
    });
}

/**
 * Runner sends a WS frame from the local service → forward to viewer's raw socket.
 * The data arrives as base64 (binary) or text — we must wrap it in a WS frame.
 */
export function handleTunnelWsData(tunnelWsId: string, data: string, binary?: boolean): void {
    const rawSocket = activeTunnelWs.get(tunnelWsId);
    if (!rawSocket || rawSocket.destroyed) return;

    const payload = binary ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
    const frame = encodeWsFrame(payload, binary ? 0x02 : 0x01);
    rawSocket.write(frame);
}

/**
 * Runner signals the local WS closed — send close frame to viewer and clean up.
 */
export function handleTunnelWsClose(tunnelWsId: string, code?: number, reason?: string): void {
    const rawSocket = activeTunnelWs.get(tunnelWsId);
    if (rawSocket && !rawSocket.destroyed) {
        // Send a WebSocket close frame
        const closeCode = code ?? 1000;
        const reasonBuf = reason ? Buffer.from(reason, "utf8") : Buffer.alloc(0);
        const payload = Buffer.alloc(2 + reasonBuf.length);
        payload.writeUInt16BE(closeCode, 0);
        if (reasonBuf.length > 0) reasonBuf.copy(payload, 2);
        const frame = encodeWsFrame(payload, 0x08);
        rawSocket.write(frame);
        rawSocket.end();
    }
    activeTunnelWs.delete(tunnelWsId);
    // Runner's runnerId lookup not needed for cleanup — the runner already cleaned up
}

/**
 * Runner reports a WS error — reject pending or close active connection.
 */
export function handleTunnelWsError(tunnelWsId: string, message: string): void {
    // If still pending, reject the upgrade
    const pending = pendingTunnelWs.get(tunnelWsId);
    if (pending) {
        clearTimeout(pending.timer);
        pendingTunnelWs.delete(tunnelWsId);
        removeTunnelWsFromRunner(pending.runnerId, tunnelWsId);
        rejectUpgrade(pending.rawSocket, 502, `Tunnel WS error: ${message}`);
        return;
    }

    // If active, close the viewer connection
    const rawSocket = activeTunnelWs.get(tunnelWsId);
    if (rawSocket && !rawSocket.destroyed) {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(1011, 0);
        const frame = encodeWsFrame(payload, 0x08);
        rawSocket.write(frame);
        rawSocket.end();
    }
    activeTunnelWs.delete(tunnelWsId);
}

/**
 * Clean up all tunnel WS connections for a disconnected runner.
 */
export function cleanupRunnerTunnelWs(runnerId: string): void {
    const wsIds = runnerTunnelWsIds.get(runnerId);
    if (!wsIds) return;

    for (const tunnelWsId of wsIds) {
        // Clean pending
        const pending = pendingTunnelWs.get(tunnelWsId);
        if (pending) {
            clearTimeout(pending.timer);
            pendingTunnelWs.delete(tunnelWsId);
            rejectUpgrade(pending.rawSocket, 503, "Runner disconnected");
        }

        // Clean active
        const rawSocket = activeTunnelWs.get(tunnelWsId);
        if (rawSocket && !rawSocket.destroyed) {
            const payload = Buffer.alloc(2);
            payload.writeUInt16BE(1001, 0);
            const frame = encodeWsFrame(payload, 0x08);
            rawSocket.write(frame);
            rawSocket.end();
        }
        activeTunnelWs.delete(tunnelWsId);
        // Clear frame parser state to prevent memory leaks on runner disconnect.
        frameParsers.delete(tunnelWsId);
        currentMsgIsBinary.delete(tunnelWsId);
    }

    runnerTunnelWsIds.delete(runnerId);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function removeTunnelWsFromRunner(runnerId: string, tunnelWsId: string): void {
    const set = runnerTunnelWsIds.get(runnerId);
    if (set) {
        set.delete(tunnelWsId);
        if (set.size === 0) runnerTunnelWsIds.delete(runnerId);
    }
}

async function authenticateUpgrade(req: IncomingMessage): Promise<{ userId: string } | null> {
    // Build a minimal Request-like object for better-auth
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `${proto}://${host}`);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v);
        } else {
            headers.set(key, value);
        }
    }

    // Try session-based auth (cookies)
    try {
        const session = await getAuth().api.getSession({ headers });
        if (session?.user?.id) {
            return { userId: session.user.id };
        }
    } catch { /* fall through to API key */ }

    // Try API key auth (x-api-key header or query param)
    const apiKey = headers.get("x-api-key") ?? url.searchParams.get("apiKey");
    if (apiKey) {
        try {
            const result = await getAuth().api.verifyApiKey({ body: { key: apiKey } });
            if (result.valid && result.key?.userId) {
                return { userId: result.key.userId };
            }
        } catch { /* reject */ }
    }

    return null;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
    if (socket.destroyed) return;
    socket.write(
        `HTTP/1.1 ${status} ${message}\r\n` +
        "Content-Type: text/plain\r\n" +
        `Content-Length: ${Buffer.byteLength(message)}\r\n` +
        "\r\n" +
        message,
    );
    socket.end();
}

// ── WebSocket frame codec (RFC 6455) ──────────────────────────────────────────
// We operate on raw TCP sockets so we need minimal WS framing.

/**
 * Encode a payload into a WebSocket frame (server → client, unmasked).
 */
function encodeWsFrame(payload: Buffer, opcode: number): Buffer {
    const len = payload.length;
    let headerLen: number;

    if (len < 126) {
        headerLen = 2;
    } else if (len < 65536) {
        headerLen = 4;
    } else {
        headerLen = 10;
    }

    const frame = Buffer.alloc(headerLen + len);
    frame[0] = 0x80 | opcode; // FIN + opcode

    if (len < 126) {
        frame[1] = len;
    } else if (len < 65536) {
        frame[1] = 126;
        frame.writeUInt16BE(len, 2);
    } else {
        frame[1] = 127;
        // Write as two 32-bit values (JS doesn't have native 64-bit int writes for small buffers)
        frame.writeUInt32BE(0, 2);
        frame.writeUInt32BE(len, 6);
    }

    payload.copy(frame, headerLen);
    return frame;
}

/**
 * Minimal WebSocket frame parser state machine.
 * Client → server frames are always masked (RFC 6455 §5.1).
 */
class WsFrameParser {
    private buffer = Buffer.alloc(0);

    /**
     * Feed raw bytes and extract complete frames.
     * Returns an array of { opcode, payload } for each complete frame.
     */
    parse(chunk: Buffer): Array<{ opcode: number; payload: Buffer }> {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const frames: Array<{ opcode: number; payload: Buffer }> = [];

        while (this.buffer.length >= 2) {
            const firstByte = this.buffer[0];
            const secondByte = this.buffer[1];
            const opcode = firstByte & 0x0f;
            const masked = (secondByte & 0x80) !== 0;
            let payloadLength = secondByte & 0x7f;
            let offset = 2;

            if (payloadLength === 126) {
                if (this.buffer.length < 4) break;
                payloadLength = this.buffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLength === 127) {
                if (this.buffer.length < 10) break;
                // Read as two 32-bit values
                const hi = this.buffer.readUInt32BE(2);
                const lo = this.buffer.readUInt32BE(6);
                payloadLength = hi * 0x100000000 + lo;
                offset = 10;
            }

            const maskLen = masked ? 4 : 0;
            const totalLen = offset + maskLen + payloadLength;

            if (this.buffer.length < totalLen) break;

            let payload: Buffer;
            if (masked) {
                const maskKey = this.buffer.subarray(offset, offset + 4);
                payload = Buffer.alloc(payloadLength);
                for (let i = 0; i < payloadLength; i++) {
                    payload[i] = this.buffer[offset + 4 + i] ^ maskKey[i % 4];
                }
            } else {
                payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
            }

            frames.push({ opcode, payload });
            this.buffer = Buffer.from(this.buffer.subarray(totalLen));
        }

        return frames;
    }
}

/** Per-connection frame parsers for incoming viewer data. */
const frameParsers = new Map<string, WsFrameParser>();

/**
 * Tracks the binary/text type of the currently-in-progress fragmented message,
 * keyed by tunnelWsId.  Set when the initial frame (text=0x01 or binary=0x02)
 * is seen; consulted for continuation frames (opcode=0x00) so they are
 * forwarded with the correct encoding.
 */
const currentMsgIsBinary = new Map<string, boolean>();

function handleIncomingWsFrame(tunnelWsId: string, runnerId: string, chunk: Buffer): void {
    if (!frameParsers.has(tunnelWsId)) {
        frameParsers.set(tunnelWsId, new WsFrameParser());
    }
    const parser = frameParsers.get(tunnelWsId)!;
    const frames = parser.parse(chunk);

    const runnerSocket = getLocalRunnerSocket(runnerId);
    if (!runnerSocket) return;

    for (const { opcode, payload } of frames) {
        if (opcode === 0x08) {
            // Close frame — forward to runner
            const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
            const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
            (runnerSocket as Socket).emit("tunnel_ws_close" as any, { tunnelWsId, code, reason });

            // Echo close frame back to viewer and clean up
            const rawSocket = activeTunnelWs.get(tunnelWsId);
            if (rawSocket && !rawSocket.destroyed) {
                const echoFrame = encodeWsFrame(payload, 0x08);
                rawSocket.write(echoFrame);
                rawSocket.end();
            }
            activeTunnelWs.delete(tunnelWsId);
            frameParsers.delete(tunnelWsId);
            currentMsgIsBinary.delete(tunnelWsId);
            removeTunnelWsFromRunner(runnerId, tunnelWsId);
            return;
        }

        if (opcode === 0x09) {
            // Ping — respond with pong
            const rawSocket = activeTunnelWs.get(tunnelWsId);
            if (rawSocket && !rawSocket.destroyed) {
                const pong = encodeWsFrame(payload, 0x0a);
                rawSocket.write(pong);
            }
            continue;
        }

        if (opcode === 0x0a) {
            // Pong — ignore
            continue;
        }

        // Data frames (text=0x01, binary=0x02, continuation=0x00).
        // RFC 6455 §5.4: fragmented messages start with a non-zero opcode (0x01 or
        // 0x02) and are followed by continuation frames (0x00).  We track the
        // initial frame's type so continuation frames are forwarded with the
        // correct encoding rather than always being treated as text.
        let isBinary: boolean;
        if (opcode === 0x01 || opcode === 0x02) {
            isBinary = opcode === 0x02;
            currentMsgIsBinary.set(tunnelWsId, isBinary);
        } else {
            // opcode === 0x00: continuation — inherit type from the initial frame.
            isBinary = currentMsgIsBinary.get(tunnelWsId) ?? false;
        }
        (runnerSocket as Socket).emit("tunnel_ws_data" as any, {
            tunnelWsId,
            data: isBinary
                ? payload.toString("base64")
                : payload.toString("utf8"),
            binary: isBinary || undefined,
        });
    }
}

// Export for cleanup when frame parser is no longer needed
export function cleanupFrameParser(tunnelWsId: string): void {
    frameParsers.delete(tunnelWsId);
    currentMsgIsBinary.delete(tunnelWsId);
}
