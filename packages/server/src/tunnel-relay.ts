import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { TunnelRelay } from "@pizzapi/tunnel";
import { WebSocketServer, type WebSocket as NodeWebSocket, type RawData } from "ws";
import { bindAuthContext, getAuth, type AuthContext } from "./auth.js";

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

export function initTunnelRelay(context: AuthContext): TunnelRelay {
    if (relay && wss) return relay;

    relay = new TunnelRelay({
        apiKeys: bindAuthContext(context, async (key: string): Promise<boolean> => {
            try {
                const result = await getAuth().api.verifyApiKey({ body: { key } });
                return !!(result.valid && result.key?.userId);
            } catch {
                return false;
            }
        }),
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
