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
const STRIP_AUTH_HEADERS = new Set(["cookie", "authorization", "x-api-key"]);

// ── Response cache ────────────────────────────────────────────────────────

interface CacheEntry {
    status: number;
    headers: Record<string, string>;
    body: string;
    expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 100;

// ── Standalone HTTP proxy ─────────────────────────────────────────────────

export interface ProxyResult {
    status: number;
    headers: Record<string, string>;
    body: string; // base64-encoded
    error?: string;
}

/**
 * Proxy a single HTTP request to a local port and return the result.
 *
 * Security features:
 *  - SSRF guard: validates final URL hostname is 127.0.0.1 (via URL constructor)
 *  - Hop-by-hop header stripping
 *  - Auth header stripping (cookie, authorization)
 *  - Body size guard (MAX_RESPONSE_BYTES)
 *  - Redirect blocking (`redirect: "manual"`)
 *  - 10s timeout via AbortSignal.timeout
 *  - Forces `accept-encoding: identity` so local services send uncompressed bodies
 *  - Strips `content-encoding` from response headers (Bun transparently decompresses)
 */
export async function httpProxy(
    port: number,
    method: string,
    path: string,
    headers: Record<string, string>,
    bodyBase64: string | undefined,
): Promise<ProxyResult> {
    try {
        const rawUrl = `http://127.0.0.1:${port}${path}`;

        // SSRF via path injection guard: a path containing `@` can cause URL
        // parsers to treat `127.0.0.1:${port}` as credentials.
        // Parse and assert the final hostname before fetching.
        const parsedUrl = new URL(rawUrl);
        if (parsedUrl.hostname !== "127.0.0.1") {
            const error = `SSRF guard: unexpected hostname '${parsedUrl.hostname}'`;
            return { status: 400, headers: {}, body: Buffer.from(error).toString("base64"), error };
        }

        const bodyBytes = bodyBase64 ? Buffer.from(bodyBase64, "base64") : undefined;

        // Strip hop-by-hop and auth headers before forwarding.
        // Auth headers (cookie, authorization) must not leak from the
        // viewer's authenticated session to the tunneled localhost service.
        const forwardHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
            const lk = k.toLowerCase();
            if (!HOP_BY_HOP.has(lk) && !STRIP_AUTH_HEADERS.has(lk)) forwardHeaders[k] = v;
        }

        // Force identity encoding so local services don't compress bodies.
        // Bun's fetch transparently decompresses gzip/br, so any Content-Encoding
        // in the response would be stale and mislead the relay consumer.
        forwardHeaders["accept-encoding"] = "identity";

        // SSRF via redirect-following guard: use `redirect: "manual"` so a
        // localhost service cannot redirect us to an internal network address
        // (169.254.169.254, 10.x.x.x, etc.). 3xx responses are passed back as-is.
        const fetchResponse = await fetch(parsedUrl.toString(), {
            method,
            headers: forwardHeaders,
            // body must be undefined for bodyless methods to avoid fetch errors
            body: bodyBytes && bodyBytes.byteLength > 0 ? bodyBytes : undefined,
            signal: AbortSignal.timeout(10_000),
            redirect: "manual",
        });

        const responseBuffer = await fetchResponse.arrayBuffer();

        if (responseBuffer.byteLength > MAX_RESPONSE_BYTES) {
            const error = `Response body exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB limit`;
            return { status: 413, headers: {}, body: Buffer.from(error).toString("base64"), error };
        }

        const responseHeaders: Record<string, string> = {};
        // Strip hop-by-hop, content-encoding, and content-length from response headers.
        // Since we forced accept-encoding: identity, any content-encoding value in the
        // response is stale after Bun's transparent decompression.  content-length is
        // also stripped because the relay consumer determines body size from the base64
        // payload, and the original byte-length would be misleading.
        fetchResponse.headers.forEach((v, k) => {
            const lk = k.toLowerCase();
            if (!HOP_BY_HOP.has(lk) && lk !== "content-encoding" && lk !== "content-length") {
                responseHeaders[k] = v;
            }
        });

        return {
            status: fetchResponse.status,
            headers: responseHeaders,
            body: Buffer.from(responseBuffer).toString("base64"),
        };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
            status: 502,
            headers: {},
            body: Buffer.from(error).toString("base64"),
            error,
        };
    }
}

// ── TunnelService ─────────────────────────────────────────────────────────

export class TunnelService implements ServiceHandler {
    readonly id = "tunnel";

    private tunnels = new Map<number, TunnelInfo>();
    private socket: Socket | null = null;
    /** Active WebSocket tunnel connections: tunnelWsId → WebSocket */
    private wsConnections = new Map<string, WebSocket>();
    /** Reverse index: tunnelWsId → port (for bulk-close on unexpose) */
    private wsPortMap = new Map<string, number>();

    // ── Response cache (LRU via Map insertion-order) ──────────────────────
    private responseCache = new Map<string, CacheEntry>();

    /** Return a cached entry if it exists and has not expired, or undefined. */
    private cacheGet(key: string): CacheEntry | undefined {
        const entry = this.responseCache.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
            this.responseCache.delete(key);
            return undefined;
        }
        // Promote to MRU: delete + re-insert so Map iteration order reflects recency.
        this.responseCache.delete(key);
        this.responseCache.set(key, entry);
        return entry;
    }

    /** Store an entry, sweeping expired entries and evicting LRU if at capacity. */
    private cacheSet(key: string, data: Omit<CacheEntry, "expiresAt">): void {
        // Sweep expired entries first.
        const now = Date.now();
        for (const [k, v] of this.responseCache) {
            if (now > v.expiresAt) this.responseCache.delete(k);
        }
        // Evict least-recently-used (first entry in Map) if still at max.
        if (this.responseCache.size >= CACHE_MAX_SIZE) {
            const lruKey = this.responseCache.keys().next().value;
            if (lruKey !== undefined) this.responseCache.delete(lruKey);
        }
        this.responseCache.set(key, { ...data, expiresAt: now + CACHE_TTL_MS });
    }

    /** Invalidate all cached entries for a given port (called on unexpose). */
    private cacheInvalidatePort(port: number): void {
        const prefix = `${port}:`;
        for (const k of this.responseCache.keys()) {
            if (k.startsWith(prefix)) this.responseCache.delete(k);
        }
    }

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
            if (isShuttingDown()) return;
            this.handleWsClose(data);
        });
    }

    dispose(): void {
        // Close all active WebSocket tunnel connections
        for (const [, ws] of this.wsConnections) {
            try { ws.close(1001, "tunnel service disposed"); } catch { /* ignore */ }
        }
        this.wsConnections.clear();
        this.wsPortMap.clear();
        this.tunnels.clear();
        this.responseCache.clear();
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
            this.cacheInvalidatePort(port);

            // Close all active WS connections proxying through this port.
            // Collect IDs first to avoid mutating the Map during iteration.
            const toClose: string[] = [];
            for (const [tunnelWsId, wsPort] of this.wsPortMap) {
                if (wsPort === port) toClose.push(tunnelWsId);
            }
            for (const tunnelWsId of toClose) {
                const ws = this.wsConnections.get(tunnelWsId);
                if (ws) {
                    try { ws.close(1001, "tunnel unexposed"); } catch { /* ignore */ }
                }
                this.wsConnections.delete(tunnelWsId);
                this.wsPortMap.delete(tunnelWsId);
            }
            if (toClose.length > 0) {
                logInfo(`[tunnel] closed ${toClose.length} WS connection(s) for unexposed port ${port}`);
            }

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

        // ── Cache lookup (GET requests only) ──────────────────────────────────
        const cacheKey = `${port}:${method}:${path}`;
        if (method === "GET") {
            const cached = this.cacheGet(cacheKey);
            if (cached) {
                (this.socket as any).emit("tunnel_response", {
                    requestId,
                    status: cached.status,
                    headers: cached.headers,
                    body: cached.body,
                } satisfies TunnelResponseData);
                return;
            }
        }

        // ── Proxy the request ─────────────────────────────────────────────────
        const result = await httpProxy(port, method, path, headers, body);

        // Re-check socket after awaiting — dispose() may have run during the request.
        if (!this.socket) return;

        if (result.error) {
            logError(`[tunnel] HTTP proxy error for port ${port}: ${result.error}`);
        }

        // ── Cache storage (GET 200 without no-store/no-cache) ─────────────────
        if (
            method === "GET" &&
            result.status === 200 &&
            !result.error
        ) {
            const cc = (result.headers["cache-control"] ?? "").toLowerCase();
            if (!cc.includes("no-store") && !cc.includes("no-cache")) {
                this.cacheSet(cacheKey, {
                    status: result.status,
                    headers: result.headers,
                    body: result.body,
                });
            }
        }

        response.status = result.status;
        response.headers = result.headers;
        response.body = result.body;
        if (result.error) response.error = result.error;

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
            // Use Bun's extended WebSocket constructor to forward headers
            // (e.g. Host override) to the local service.  The standard two-arg
            // `new WebSocket(url, protocols)` form does not accept headers.
            const ws = new (WebSocket as any)(parsedUrl.toString(), {
                headers: forwardHeaders,
                protocols,
            }) as WebSocket;

            // Store immediately so we can close on dispose or unexpose
            this.wsConnections.set(tunnelWsId, ws);
            this.wsPortMap.set(tunnelWsId, port);

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
                this.wsPortMap.delete(tunnelWsId);
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
                this.wsPortMap.delete(tunnelWsId);
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
            this.wsPortMap.delete(tunnelWsId);
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
        this.wsPortMap.delete(tunnelWsId);
        try {
            ws.close(code ?? 1000, reason ?? "");
        } catch { /* ignore — may already be closed */ }
        logInfo(`[tunnel] WS close (from viewer) tunnelWsId=${tunnelWsId}`);
    }
}
