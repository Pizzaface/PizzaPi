import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { TunnelRelay } from "@pizzapi/tunnel";
import { WebSocketServer, type WebSocket as NodeWebSocket, type RawData } from "ws";
import { getAuth } from "./auth.js";
import { getRunnerData } from "./ws/sio-registry/runners.js";

let relay: TunnelRelay | null = null;
let wss: WebSocketServer | null = null;

interface BrowserCompatibleWebSocket {
    readyState: number;
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

function adaptWs(ws: NodeWebSocket): BrowserCompatibleWebSocket {
    return {
        get readyState() {
            return ws.readyState as number;
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

export function initTunnelRelay(): TunnelRelay {
    if (relay && wss) return relay;

    relay = new TunnelRelay({
        apiKeys: async (key: string): Promise<{ userId: string } | false> => {
            try {
                const result = await getAuth().api.verifyApiKey({ body: { key } });
                if (!result.valid || !result.key?.userId) return false;
                return { userId: result.key.userId };
            } catch {
                return false;
            }
        },
        verifyRunner: async (runnerId: string, userId: string): Promise<boolean> => {
            try {
                const runner = await getRunnerData(runnerId);
                // If the runner isn't registered yet (Socket.IO hasn't fired yet),
                // allow the tunnel connection — the ownership check will be enforced
                // when the runner registers via Socket.IO.
                // If the runner is registered, verify it belongs to this user.
                if (runner && runner.userId && runner.userId !== userId) {
                    return false;
                }
                return true;
            } catch {
                // On Redis errors, allow the connection rather than blocking legitimate runners.
                return true;
            }
        },
        log: {
            info: (...args) => console.log("[tunnel-relay]", ...args),
            debug: (...args) => {
                if (process.env.DEBUG) console.debug("[tunnel-relay]", ...args);
            },
            error: (...args) => console.error("[tunnel-relay]", ...args),
            warn: (...args) => console.warn("[tunnel-relay]", ...args),
        },
    });

    wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (ws) => {
        relay!.handleConnection(adaptWs(ws) as unknown as WebSocket);
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
    if (!wss) return false;

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
