import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket as NodeWebSocket } from "ws";
import { getAuth } from "../auth.js";
import { getTunnelRelay } from "../tunnel-relay.js";
import { getSession } from "../ws/sio-state.js";
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

const tunnelProxyWss = new WebSocketServer({ noServer: true });

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

    if (!sessionId || !Number.isFinite(port) || port < 1 || port > 65535) {
        rejectUpgrade(rawSocket, 400, "Bad Request");
        return;
    }

    const identity = await authenticateUpgrade(req);
    if (!identity) {
        rejectUpgrade(rawSocket, 401, "Unauthorized");
        return;
    }

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

    const relay = getTunnelRelay();
    if (!relay?.hasRunner(runnerId)) {
        rejectUpgrade(rawSocket, 503, "Runner not available");
        return;
    }

    const protocols = req.headers["sec-websocket-protocol"]
        ? req.headers["sec-websocket-protocol"].split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;

    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        const lowerKey = key.toLowerCase();
        if (HOP_BY_HOP.has(lowerKey)) continue;
        if (lowerKey === "cookie" || lowerKey === "authorization" || lowerKey === "x-api-key") continue;
        forwardHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
    }

    const tunnelWsId = `tws-${sessionId}-${port}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let viewerWs: NodeWebSocket | null = null;
    let closingFromRelay = false;
    let handshakeComplete = false;

    const finalizeUpgrade = (protocol?: string): void => {
        if (handshakeComplete || rawSocket.destroyed) {
            if (rawSocket.destroyed) {
                relay.sendWsClose(runnerId, tunnelWsId, 1001, "viewer disconnected");
            }
            return;
        }

        if (protocol) {
            req.headers["sec-websocket-protocol"] = protocol;
        }

        handshakeComplete = true;
        tunnelProxyWss.handleUpgrade(req, rawSocket, head, (ws) => {
            viewerWs = ws;

            ws.on("message", (data, isBinary) => {
                relay.sendWsData(
                    runnerId,
                    tunnelWsId,
                    isBinary ? Buffer.from(data as Buffer).toString("base64") : data.toString(),
                    isBinary || undefined,
                );
            });

            ws.on("close", (code, reason) => {
                if (!closingFromRelay) {
                    relay.sendWsClose(runnerId, tunnelWsId, code, reason.toString());
                }
            });

            ws.on("error", () => {
                if (!closingFromRelay) {
                    relay.sendWsClose(runnerId, tunnelWsId, 1011, "viewer websocket error");
                }
            });
        });
    };

    const closePendingSocket = (status: number, message: string): void => {
        if (handshakeComplete || rawSocket.destroyed) return;
        rejectUpgrade(rawSocket, status, message);
    };

    const proxy = relay.proxyWsOpen(
        runnerId,
        {
            id: tunnelWsId,
            port,
            path: pathWithQuery,
            protocols,
            headers: forwardHeaders,
        },
        {
            onOpened: (protocol) => {
                finalizeUpgrade(protocol);
            },
            onData: (data, binary) => {
                if (!viewerWs || viewerWs.readyState !== NodeWebSocket.OPEN) return;
                viewerWs.send(binary ? Buffer.from(data, "base64") : data);
            },
            onClose: (code, reason) => {
                if (!handshakeComplete) {
                    closePendingSocket(502, reason || "Tunnel WebSocket closed");
                    return;
                }

                if (!viewerWs || viewerWs.readyState >= NodeWebSocket.CLOSING) return;
                closingFromRelay = true;
                viewerWs.close(code ?? 1000, reason ?? "");
            },
            onError: (message) => {
                if (!handshakeComplete) {
                    const status = message.includes("not connected") || message.includes("disconnected") ? 503 : 502;
                    closePendingSocket(status, message);
                    return;
                }

                if (!viewerWs || viewerWs.readyState >= NodeWebSocket.CLOSING) return;
                closingFromRelay = true;
                viewerWs.close(1011, message);
            },
        },
    );

    rawSocket.once("close", () => {
        if (!handshakeComplete) {
            proxy.cancel();
        }
    });

    rawSocket.once("error", () => {
        if (!handshakeComplete) {
            proxy.cancel();
        }
    });
}

async function authenticateUpgrade(req: IncomingMessage): Promise<{ userId: string } | null> {
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `${proto}://${host}`);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            for (const entry of value) headers.append(key, entry);
        } else {
            headers.set(key, value);
        }
    }

    try {
        const session = await getAuth().api.getSession({ headers });
        if (session?.user?.id) {
            return { userId: session.user.id };
        }
    } catch {
        // Fall through to API key auth.
    }

    const apiKey = headers.get("x-api-key") ?? url.searchParams.get("apiKey");
    if (apiKey) {
        try {
            const result = await getAuth().api.verifyApiKey({ body: { key: apiKey } });
            if (result.valid && result.key?.userId) {
                return { userId: result.key.userId };
            }
        } catch {
            // reject below
        }
    }

    return null;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
    if (socket.destroyed) return;
    socket.write(
        `HTTP/1.1 ${status} ${message}\r\n`
        + "Content-Type: text/plain\r\n"
        + `Content-Length: ${Buffer.byteLength(message)}\r\n`
        + "\r\n"
        + message,
    );
    socket.end();
}
