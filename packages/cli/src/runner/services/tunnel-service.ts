/**
 * TunnelService — expose local ports to authenticated remote viewers via the PizzaPi relay.
 *
 * Supports both HTTP proxy (request/response over Socket.IO) and WebSocket
 * proxy (WS-over-Socket.IO framing for Vite HMR, Socket.IO apps, etc.).
 *
 * Remaining limitations:
 *   - No streaming HTTP responses (body fully buffered before forwarding)
 *   - No SSE support
 *   - No CORS handling beyond header passthrough
 *   - Not suitable for large file downloads (>10 MB)
 */

import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions, ServiceEnvelope } from "../service-handler.js";
import { logInfo, logError } from "../logger.js";

// Local type definitions — mirrors packages/protocol/src/shared.ts.
// Using inline aliases avoids the cross-worktree symlink issue where
// node_modules/@pizzapi/protocol resolves to the main branch's dist.

interface TunnelInfo {
    port: number;
    name?: string;
    /** Relay tunnel URL fragment — actual URL is /api/tunnel/{sessionId}/{port}/ */
    url: string;
    /** Auto-registered by the daemon (e.g. service panel port) — hidden from session TunnelPanel. */
    pinned?: boolean;
}

interface TunnelRequestData {
    requestId: string;
    port: number;
    method: string;
    path: string;
    headers: Record<string, string>;
    /** Request body, base64-encoded. Absent for bodyless methods. */
    body?: string;
}

interface TunnelResponseData {
    requestId: string;
    status: number;
    headers: Record<string, string>;
    /** Response body, base64-encoded. */
    body: string;
    /** Set when the proxy itself failed. */
    error?: string;
}

// ── Tunnel WebSocket proxy types (mirrors protocol/shared.ts) ─────────────

interface TunnelWsOpenData {
    tunnelWsId: string;
    port: number;
    path: string;
    protocols?: string[];
    headers: Record<string, string>;
}

interface TunnelWsDataPayload {
    tunnelWsId: string;
    data: string;
    binary?: boolean;
}

interface TunnelWsCloseData {
    tunnelWsId: string;
    code?: number;
    reason?: string;
}

interface TunnelWsErrorData {
    tunnelWsId: string;
    message: string;
}

interface TunnelWsOpenedData {
    tunnelWsId: string;
    protocol?: string;
}

/** Maximum response body size that will be relayed (10 MB). */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Hop-by-hop headers that must not be forwarded in either direction. */
const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    // Rewritten to 127.0.0.1:{port} by the runner — strip the viewer's value.
    "host",
]);

/**
 * Auth headers that must never leak from the viewer session to the tunneled
 * localhost service.  Stripping these prevents credential forwarding (SSRF
 * auth-leakage vector).
 */
const STRIP_AUTH_HEADERS = new Set(["cookie", "authorization"]);

export class TunnelService implements ServiceHandler {
    readonly id = "tunnel";

    private tunnels = new Map<number, TunnelInfo>();
    private socket: Socket | null = null;
    /** Active WebSocket tunnel connections: tunnelWsId → WebSocket */
    private wsConnections = new Map<string, WebSocket>();

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
        this.socket = socket;

        // ── Viewer → Runner: service_message commands ─────────────────────────
        (socket as any).on("service_message", (envelope: ServiceEnvelope) => {
            if (isShuttingDown()) return;
            if (envelope.serviceId !== "tunnel") return;

            switch (envelope.type) {
                case "tunnel_list":
                    this.handleList(envelope.requestId);
                    break;
                case "tunnel_expose":
                    this.handleExpose(envelope.requestId, envelope.payload as { port: number; name?: string });
                    break;
                case "tunnel_unexpose":
                    this.handleUnexpose(envelope.payload as { port: number });
                    break;
            }
        });

        // ── Server → Runner: tunnel_request (HTTP proxy) ───────────────────────
        (socket as any).on("tunnel_request", async (data: TunnelRequestData) => {
            if (isShuttingDown()) return;
            await this.handleHttpRequest(data);
        });

        // ── Server → Runner: tunnel_ws_open (WebSocket proxy) ─────────────────
        (socket as any).on("tunnel_ws_open", (data: TunnelWsOpenData) => {
            if (isShuttingDown()) return;
            this.handleWsOpen(data);
        });

        // ── Server → Runner: tunnel_ws_data (WebSocket frame from viewer) ─────
        (socket as any).on("tunnel_ws_data", (data: TunnelWsDataPayload) => {
            if (isShuttingDown()) return;
            this.handleWsData(data);
        });

        // ── Server → Runner: tunnel_ws_close (viewer WS closed) ──────────────
        (socket as any).on("tunnel_ws_close", (data: TunnelWsCloseData) => {
            this.handleWsClose(data);
        });
    }

    dispose(): void {
        // Close all active WebSocket tunnel connections
        for (const [id, ws] of this.wsConnections) {
            try { ws.close(1001, "tunnel service disposed"); } catch { /* ignore */ }
        }
        this.wsConnections.clear();
        this.tunnels.clear();
        this.socket = null;
    }

    // ── Internal API (called by daemon, not via socket) ───────────────────

    /**
     * Register a port for HTTP proxying without a viewer-initiated tunnel_expose.
     * Used by the daemon to auto-expose panel ports from folder-based services.
     */
    registerPort(port: number, name?: string): void {
        if (this.tunnels.has(port)) return;
        const url = `/tunnel/${port}`;
        const info: TunnelInfo = { port, ...(name ? { name } : {}), url, pinned: true };
        this.tunnels.set(port, info);
        logInfo(`[tunnel] auto-registered panel port ${port}${name ? ` (${name})` : ""}`);

        // Announce to server so it knows the port is proxiable
        if (this.socket) {
            (this.socket as any).emit("service_message", {
                serviceId: "tunnel",
                type: "tunnel_registered",
                payload: info,
            } satisfies ServiceEnvelope);
        }
    }

    // ── Command handlers ──────────────────────────────────────────────────────

    private handleList(requestId?: string): void {
        if (!this.socket) return;
        const tunnels = Array.from(this.tunnels.values());
        (this.socket as any).emit("service_message", {
            serviceId: "tunnel",
            type: "tunnel_list_result",
            requestId,
            payload: { tunnels },
        } satisfies ServiceEnvelope);
    }

    private handleExpose(requestId: string | undefined, payload: { port: number; name?: string }): void {
        if (!this.socket) return;
        const { port, name } = payload;

        if (!port || port < 1 || port > 65535) {
            (this.socket as any).emit("service_message", {
                serviceId: "tunnel",
                type: "tunnel_error",
                requestId,
                payload: { error: `Invalid port: ${port}` },
            } satisfies ServiceEnvelope);
            return;
        }

        // URL placeholder — the actual URL is constructed client-side using
        // the viewer's known server URL: /api/tunnel/{sessionId}/{port}/
        const url = `/tunnel/${port}`;
        const info: TunnelInfo = { port, ...(name ? { name } : {}), url };
        this.tunnels.set(port, info);
        logInfo(`[tunnel] exposed port ${port}${name ? ` (${name})` : ""}`);

        (this.socket as any).emit("service_message", {
            serviceId: "tunnel",
            type: "tunnel_registered",
            requestId,
            payload: info,
        } satisfies ServiceEnvelope);
    }

    private handleUnexpose(payload: { port: number }): void {
        if (!this.socket) return;
        const { port } = payload;

        if (this.tunnels.delete(port)) {
            logInfo(`[tunnel] unexposed port ${port}`);
            (this.socket as any).emit("service_message", {
                serviceId: "tunnel",
                type: "tunnel_removed",
                payload: { port },
            } satisfies ServiceEnvelope);
        }
    }

    // ── HTTP proxy ────────────────────────────────────────────────────────────

    private async handleHttpRequest(data: TunnelRequestData): Promise<void> {
        if (!this.socket) return;
        const { requestId, port, method, path, headers, body } = data;

        const response: TunnelResponseData = {
            requestId,
            status: 500,
            headers: {},
            body: "",
        };

        // Reject requests for unexposed ports
        if (!this.tunnels.has(port)) {
            response.status = 404;
            response.error = `Port ${port} is not exposed`;
            response.body = Buffer.from(response.error).toString("base64");
            (this.socket as any).emit("tunnel_response", response);
            return;
        }

        try {
            const rawUrl = `http://127.0.0.1:${port}${path}`;

            // ── Bug 2: SSRF via path injection ────────────────────────────────
            // A path containing `@` can cause URL parsers to treat
            // `127.0.0.1:${port}` as credentials (e.g. http://127.0.0.1:3000@evil/).
            // Parse and assert the final hostname before fetching.
            const parsedUrl = new URL(rawUrl);
            if (parsedUrl.hostname !== "127.0.0.1") {
                response.status = 400;
                response.error = `SSRF guard: unexpected hostname '${parsedUrl.hostname}'`;
                response.body = Buffer.from(response.error).toString("base64");
                (this.socket as any).emit("tunnel_response", response);
                return;
            }

            const bodyBytes = body ? Buffer.from(body, "base64") : undefined;

            // Strip hop-by-hop and auth headers before forwarding.
            // Auth headers (cookie, authorization) must not leak from the
            // viewer's authenticated session to the tunneled localhost service.
            const forwardHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(headers)) {
                const lk = k.toLowerCase();
                if (!HOP_BY_HOP.has(lk) && !STRIP_AUTH_HEADERS.has(lk)) forwardHeaders[k] = v;
            }

            // ── Bug 1: SSRF via redirect-following ────────────────────────────
            // Default fetch follows 301/302 — a localhost service could redirect
            // to an internal network address (169.254.169.254, 10.x.x.x, etc.).
            // Use `redirect: "manual"` and pass 3xx responses back as-is.
            const fetchResponse = await fetch(parsedUrl.toString(), {
                method,
                headers: forwardHeaders,
                // body must be undefined for bodyless methods to avoid fetch errors
                body: bodyBytes && bodyBytes.byteLength > 0 ? bodyBytes : undefined,
                signal: AbortSignal.timeout(10_000),
                redirect: "manual",
            });

            // ── P2: Race guard — dispose() may have nulled the socket ─────────
            // We awaited above; re-check before touching this.socket.
            if (!this.socket) return;

            const responseBuffer = await fetchResponse.arrayBuffer();

            // Re-check after second await.
            if (!this.socket) return;

            if (responseBuffer.byteLength > MAX_RESPONSE_BYTES) {
                response.status = 413;
                response.error = `Response body exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB limit`;
                response.body = Buffer.from(response.error).toString("base64");
            } else {
                response.status = fetchResponse.status;
                response.body = Buffer.from(responseBuffer).toString("base64");
                // Copy response headers (strip hop-by-hop)
                fetchResponse.headers.forEach((v, k) => {
                    if (!HOP_BY_HOP.has(k.toLowerCase())) response.headers[k] = v;
                });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logError(`[tunnel] HTTP proxy error for port ${port}: ${msg}`);
            response.status = 502;
            response.error = msg;
            response.body = Buffer.from(msg).toString("base64");
        }

        // Final null-guard: socket may have been cleared by dispose() during
        // one of the awaits above.
        if (!this.socket) return;
        (this.socket as any).emit("tunnel_response", response);
    }

    // ── WebSocket proxy ───────────────────────────────────────────────────────

    private handleWsOpen(data: TunnelWsOpenData): void {
        if (!this.socket) return;
        const { tunnelWsId, port, path, protocols, headers } = data;

        // Reject requests for unexposed ports
        if (!this.tunnels.has(port)) {
            (this.socket as any).emit("tunnel_ws_error", {
                tunnelWsId,
                message: `Port ${port} is not exposed`,
            } satisfies TunnelWsErrorData);
            return;
        }

        // SSRF guard: validate the constructed URL
        const rawUrl = `ws://127.0.0.1:${port}${path}`;
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(rawUrl);
        } catch {
            (this.socket as any).emit("tunnel_ws_error", {
                tunnelWsId,
                message: `Invalid WebSocket URL: ${rawUrl}`,
            } satisfies TunnelWsErrorData);
            return;
        }

        if (parsedUrl.hostname !== "127.0.0.1") {
            (this.socket as any).emit("tunnel_ws_error", {
                tunnelWsId,
                message: `SSRF guard: unexpected hostname '${parsedUrl.hostname}'`,
            } satisfies TunnelWsErrorData);
            return;
        }

        logInfo(`[tunnel] WS open tunnelWsId=${tunnelWsId} → ws://127.0.0.1:${port}${path}`);

        // Strip hop-by-hop and auth headers before forwarding
        const forwardHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
            const lk = k.toLowerCase();
            if (!HOP_BY_HOP.has(lk) && !STRIP_AUTH_HEADERS.has(lk)) forwardHeaders[k] = v;
        }
        // Set the correct Host header for the local service
        forwardHeaders["host"] = `127.0.0.1:${port}`;

        try {
            const ws = new WebSocket(parsedUrl.toString(), protocols);

            // Store immediately so we can close on dispose
            this.wsConnections.set(tunnelWsId, ws);

            ws.binaryType = "arraybuffer";

            ws.addEventListener("open", () => {
                if (!this.socket) return;
                (this.socket as any).emit("tunnel_ws_opened", {
                    tunnelWsId,
                    protocol: ws.protocol || undefined,
                } satisfies TunnelWsOpenedData);
            });

            ws.addEventListener("message", (event: MessageEvent) => {
                if (!this.socket) return;
                const isBinary = event.data instanceof ArrayBuffer;
                const payload: TunnelWsDataPayload = {
                    tunnelWsId,
                    data: isBinary
                        ? Buffer.from(event.data as ArrayBuffer).toString("base64")
                        : (event.data as string),
                    binary: isBinary || undefined,
                };
                (this.socket as any).emit("tunnel_ws_data", payload);
            });

            ws.addEventListener("close", (event: CloseEvent) => {
                this.wsConnections.delete(tunnelWsId);
                if (!this.socket) return;
                (this.socket as any).emit("tunnel_ws_close", {
                    tunnelWsId,
                    code: event.code,
                    reason: event.reason,
                } satisfies TunnelWsCloseData);
                logInfo(`[tunnel] WS closed tunnelWsId=${tunnelWsId} code=${event.code}`);
            });

            ws.addEventListener("error", (_event: Event) => {
                this.wsConnections.delete(tunnelWsId);
                if (!this.socket) return;
                (this.socket as any).emit("tunnel_ws_error", {
                    tunnelWsId,
                    message: "WebSocket connection error",
                } satisfies TunnelWsErrorData);
                logError(`[tunnel] WS error tunnelWsId=${tunnelWsId}`);
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logError(`[tunnel] WS open error for port ${port}: ${msg}`);
            this.wsConnections.delete(tunnelWsId);
            if (this.socket) {
                (this.socket as any).emit("tunnel_ws_error", {
                    tunnelWsId,
                    message: msg,
                } satisfies TunnelWsErrorData);
            }
        }
    }

    private handleWsData(data: TunnelWsDataPayload): void {
        const { tunnelWsId, data: frameData, binary } = data;
        const ws = this.wsConnections.get(tunnelWsId);
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        try {
            if (binary) {
                ws.send(Buffer.from(frameData, "base64"));
            } else {
                ws.send(frameData);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logError(`[tunnel] WS send error tunnelWsId=${tunnelWsId}: ${msg}`);
        }
    }

    private handleWsClose(data: TunnelWsCloseData): void {
        const { tunnelWsId, code, reason } = data;
        const ws = this.wsConnections.get(tunnelWsId);
        if (!ws) return;

        this.wsConnections.delete(tunnelWsId);
        try {
            ws.close(code ?? 1000, reason ?? "");
        } catch { /* ignore — may already be closed */ }
        logInfo(`[tunnel] WS close (from viewer) tunnelWsId=${tunnelWsId}`);
    }
}
