import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { DEFAULT_TUNNEL_RELAY_LIMITS, TunnelRelay, type TunnelRelayLimits } from "@pizzapi/tunnel";
import { WebSocketServer, type WebSocket as NodeWebSocket, type RawData } from "ws";
import { createLogger } from "@pizzapi/tools";
import { bindAuthContext, getAuth, type AuthContext } from "./auth.js";
import { getRunnerData } from "./ws/sio-registry.js";
import { lookupRunnerOwner } from "./runner-owner.js";

const log = createLogger("tunnel-relay");

let relay: TunnelRelay | null = null;
let wss: WebSocketServer | null = null;

/** Environment variables for each tunnel limit (0 disables a limit). */
export const TUNNEL_LIMIT_ENV: Readonly<Record<keyof TunnelRelayLimits, string>> = Object.freeze({
    maxRequestBodyBytes: "PIZZAPI_TUNNEL_MAX_REQUEST_BODY_BYTES",
    maxResponseBodyBytes: "PIZZAPI_TUNNEL_MAX_RESPONSE_BODY_BYTES",
    maxInFlightPerRunner: "PIZZAPI_TUNNEL_MAX_INFLIGHT_PER_RUNNER",
    maxBufferedBytes: "PIZZAPI_TUNNEL_MAX_BUFFERED_BYTES",
});

/**
 * Resolve tunnel resource limits from the environment. Values must be
 * non-negative decimal integers (0 disables that limit); anything else is
 * ignored with a warning and the default is used.
 */
export function readTunnelLimitsFromEnv(env: Record<string, string | undefined> = process.env): TunnelRelayLimits {
    const limits: TunnelRelayLimits = { ...DEFAULT_TUNNEL_RELAY_LIMITS };
    for (const key of Object.keys(TUNNEL_LIMIT_ENV) as Array<keyof TunnelRelayLimits>) {
        const name = TUNNEL_LIMIT_ENV[key];
        const raw = env[name]?.trim();
        if (!raw) continue;
        const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
        if (!Number.isSafeInteger(value)) {
            log.warn(`Ignoring invalid ${name}=${JSON.stringify(raw)}; using default ${limits[key]}`);
            continue;
        }
        limits[key] = value;
    }
    return limits;
}

interface BrowserCompatibleWebSocket {
    readyState: number;
    /** Bytes queued for sending — lets the relay apply backpressure to the runner socket. */
    readonly bufferedAmount: number;
    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "message" | "close" | "error", listener: (event: unknown) => void): void;
}

function toBrowserMessageData(data: RawData, isBinary: boolean): string | Buffer {
    if (typeof data === "string") return data;
    if (Array.isArray(data)) {
        const buffer = Buffer.concat(data.map((chunk) => Buffer.from(chunk)));
        return isBinary ? buffer : buffer.toString("utf8");
    }
    if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
        const buffer = Buffer.from(data);
        return isBinary ? buffer : buffer.toString("utf8");
    }
    if (ArrayBuffer.isView(data)) {
        const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        return isBinary ? buffer : buffer.toString("utf8");
    }
    return Buffer.from(data);
}

function rawDataBytes(data: RawData): number {
    if (Array.isArray(data)) return data.reduce((n, chunk) => n + chunk.byteLength, 0);
    return (data as ArrayBuffer | Buffer).byteLength;
}

/**
 * @param maxFrameBytes Largest runner frame accepted (0 = unlimited). Bun's
 *   `ws` compatibility layer does not enforce `maxPayload`, so oversized
 *   frames are also refused here: the link is closed with 1009 and the frame
 *   is never parsed or dispatched.
 */
function adaptWs(ws: NodeWebSocket, maxFrameBytes = 0): BrowserCompatibleWebSocket {
    return {
        get readyState() {
            return ws.readyState as number;
        },
        get bufferedAmount() {
            return ws.bufferedAmount;
        },
        send(data) {
            ws.send(data as string | Buffer);
        },
        close(code, reason) {
            ws.close(code, reason);
        },
        addEventListener(type, listener) {
            if (type === "message") {
                ws.on("message", (data, isBinary) => {
                    if (maxFrameBytes > 0 && rawDataBytes(data) > maxFrameBytes) {
                        log.warn(`Closing /_tunnel link: runner frame exceeds ${maxFrameBytes} bytes`);
                        ws.close(1009, "frame too large");
                        return;
                    }
                    listener({
                        data: toBrowserMessageData(data, isBinary),
                    });
                });
                return;
            }

            if (type === "close") {
                ws.on("close", (code, reason) => {
                    listener({ code, reason });
                });
                return;
            }

            ws.on("error", (error) => {
                listener({ error });
            });
        },
    };
}

/**
 * Authorize a tunnel `register` message: a valid user API key AND the
 * caller must already own `runnerId` — per the durable runner_owner record,
 * or (when no durable record exists yet) the live runner state. The tunnel
 * handshake carries no runner secret, so it NEVER establishes ownership:
 * the first claim of an ID happens only through Socket.IO runner
 * registration, which validates the runner secret. Returns the owning
 * userId, or null to reject. Fails closed on any lookup error.
 * Must run inside an auth context.
 */
export async function authorizeTunnelRegistration(apiKey: string, runnerId: string): Promise<string | null> {
    try {
        const result = await getAuth().api.verifyApiKey({ body: { key: apiKey } });
        if (!result.valid || !result.key?.userId) return null;
        const userId = result.key.userId;
        const runnerData = await getRunnerData(runnerId);
        if (runnerData?.userId && runnerData.userId !== userId) return null;
        // Live Redis state is deleted on disconnect, so it cannot be the only
        // authority: the durable owner (shared with Socket.IO registration)
        // decides when present. Store errors throw → reject.
        const durableOwner = await lookupRunnerOwner(runnerId);
        const owner = durableOwner ?? runnerData?.userId ?? null;
        if (owner !== userId) {
            log.warn(
                owner
                    ? `Rejected tunnel registration for runner ${runnerId}: owned by a different user`
                    : `Rejected tunnel registration for runner ${runnerId}: runner has not registered (tunnel registration cannot claim a runner ID)`,
            );
            return null;
        }
        return userId;
    } catch (err) {
        log.warn(`Tunnel registration auth failed for runner ${runnerId}:`, err);
        return null;
    }
}

export function initTunnelRelay(context: AuthContext): TunnelRelay {
    if (relay && wss) return relay;

    relay = new TunnelRelay({
        apiKeys: bindAuthContext(context, authorizeTunnelRegistration),
        limits: readTunnelLimitsFromEnv(),
        log: {
            info: (...args) => console.log("[tunnel-relay]", ...args),
            debug: (...args) => {
                if (process.env.DEBUG) console.debug("[tunnel-relay]", ...args);
            },
            error: (...args) => console.error("[tunnel-relay]", ...args),
            warn: (...args) => console.warn("[tunnel-relay]", ...args),
        },
    });

    // Bound a single runner frame by the hard buffer ceiling (closed with 1009;
    // the ws default is 100 MiB). Runners check their serialized frames
    // against the same ceiling before sending. adaptWs enforces it too, since
    // Bun's ws layer ignores maxPayload.
    const maxPayload = relay.limits.maxBufferedBytes;
    wss = new WebSocketServer({ noServer: true, ...(maxPayload > 0 ? { maxPayload } : {}) });
    wss.on("connection", (ws, req) => {
        const openedAt = Date.now();
        const remote = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown";
        log.info(`/_tunnel WebSocket connected remote=${String(remote)} ua=${req.headers["user-agent"] ?? "<none>"}`);
        ws.on("close", (code, reason) => {
            log.info(`/_tunnel WebSocket closed code=${code} reason=${reason.toString() || "<none>"} uptimeMs=${Date.now() - openedAt}`);
        });
        ws.on("error", (err) => {
            log.warn("/_tunnel WebSocket error:", err);
        });
        relay!.handleConnection(adaptWs(ws, maxPayload) as unknown as WebSocket);
    });

    return relay;
}

export function handleTunnelRelayUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
): boolean {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname !== "/_tunnel") return false;
    if (!wss) {
        log.warn("/_tunnel upgrade received before tunnel relay WebSocket server was initialized");
        return false;
    }

    const remote = req.headers["x-forwarded-for"] ?? (socket as any).remoteAddress ?? "unknown";
    log.info(`/_tunnel upgrade accepted remote=${String(remote)} headBytes=${head.length} ua=${req.headers["user-agent"] ?? "<none>"}`);
    socket.once("error", (err) => {
        log.warn("/_tunnel upgrade socket error:", err);
    });

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss!.emit("connection", ws, req);
    });
    return true;
}

export function getTunnelRelay(): TunnelRelay | null {
    return relay;
}

export function disposeTunnelRelay(): void {
    relay?.dispose();
    relay = null;

    if (wss) {
        for (const client of wss.clients) {
            try {
                client.close(1001, "server shutting down");
            } catch {
                // ignore close errors during shutdown
            }
        }
        wss.close();
        wss = null;
    }
}
