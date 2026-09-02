import type { TunnelClient } from "@pizzapi/tunnel";
import type { Socket } from "socket.io-client";
import type { ServiceHandler, ServiceInitOptions, ServiceEnvelope } from "../service-handler.js";
import { logInfo } from "../logger.js";

interface TunnelInfo {
    port: number;
    name?: string;
    /** Relay tunnel URL fragment — actual URL is /api/tunnel/{sessionId}/{port}/ */
    url: string;
    /** Auto-registered by the daemon (e.g. service panel port) — hidden from session TunnelPanel. */
    pinned?: boolean;
}

export class TunnelService implements ServiceHandler {
    readonly id = "tunnel";

    /** Runner-level pinned/auto-registered ports shared across all sessions. */
    private pinnedTunnels = new Map<number, TunnelInfo>();
    /** Session-scoped ports: sessionId -> port -> TunnelInfo. */
    private sessionTunnels = new Map<string, Map<number, TunnelInfo>>();
    /** Refcount of how many owners (sessions + pinned) currently want a port exposed. */
    private portRefCount = new Map<number, number>();

    private socket: Socket | null = null;
    private tunnelClient: TunnelClient | null = null;
    private _onServiceMessage: ((envelope: ServiceEnvelope) => void) | null = null;

    setTunnelClient(client: TunnelClient | null): void {
        this.tunnelClient = client;
        if (!client) return;

        for (const [port, count] of this.portRefCount.entries()) {
            if (count > 0) client.exposePort(port);
        }
    }

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
        this.socket = socket;

        this._onServiceMessage = (envelope: ServiceEnvelope) => {
            if (isShuttingDown()) return;
            if (envelope.serviceId !== "tunnel") return;

            const sessionId = envelope.sessionId;
            switch (envelope.type) {
                case "tunnel_list":
                    this.handleList(sessionId, envelope.requestId);
                    break;
                case "tunnel_expose":
                    this.handleExpose(sessionId, envelope.requestId, envelope.payload as { port: number; name?: string });
                    break;
                case "tunnel_unexpose":
                    this.handleUnexpose(sessionId, envelope.requestId, envelope.payload as { port: number });
                    break;
            }
        };

        (socket as any).on("service_message", this._onServiceMessage);
        this.syncSocketState();
    }

    dispose(): void {
        if (this.socket && this._onServiceMessage) {
            (this.socket as any).off("service_message", this._onServiceMessage);
        }
        this.socket = null;
        this._onServiceMessage = null;
    }

    /**
     * Register a port for HTTP proxying without a viewer-initiated tunnel_expose.
     * Used by the daemon to auto-expose panel ports from folder-based services.
     * Pinned ports are runner-level and shared across all sessions.
     */
    registerPort(port: number, name?: string): void {
        const info: TunnelInfo = {
            port,
            ...(name ? { name } : {}),
            url: `/tunnel/${port}`,
            pinned: true,
        };
        // Services re-invoke announcePanel/announceSigilServer every time they
        // (re)start their HTTP server, so the same pinned port can be registered
        // more than once. Only the first registration takes a ref — otherwise the
        // count never drains and unregisterPort() can't actually unexpose.
        const alreadyPinned = this.pinnedTunnels.has(port);
        this.pinnedTunnels.set(port, info);
        if (!alreadyPinned) this.incRef(port);
        this.tunnelClient?.exposePort(port);
        logInfo(`[tunnel] auto-registered panel port ${port}${name ? ` (${name})` : ""}`);
        this.emitTunnelRegistered(info);
    }

    /**
     * Release a pinned port previously taken by {@link registerPort}.
     *
     * Counterpart to registerPort: without this, a service that is disabled,
     * revoked, superseded, or whose plugin was deleted leaves the runner routing
     * traffic to a port it no longer owns. Session-scoped exposures of the same
     * port survive — decRef only unexposes once the last owner releases it.
     *
     * @returns true if the port was pinned and has now been released.
     */
    unregisterPort(port: number): boolean {
        if (!this.pinnedTunnels.has(port)) return false;
        this.pinnedTunnels.delete(port);
        this.decRef(port);
        logInfo(`[tunnel] released pinned port ${port}`);
        return true;
    }

    /**
     * Close all tunnels owned by a session when the session ends.
     */
    handleSessionEnded(sessionId: string): void {
        const sessionMap = this.sessionTunnels.get(sessionId);
        if (!sessionMap || sessionMap.size === 0) return;

        const ports = Array.from(sessionMap.keys());
        for (const port of ports) {
            this.removeSessionPort(sessionId, port);
        }
        this.sessionTunnels.delete(sessionId);
        logInfo(`[tunnel] cleaned up ${ports.length} tunnel(s) for ended session ${sessionId}`);
    }

    private syncSocketState(): void {
        for (const info of this.pinnedTunnels.values()) {
            this.emitTunnelRegistered(info);
        }
        for (const [sessionId, sessionMap] of this.sessionTunnels.entries()) {
            for (const info of sessionMap.values()) {
                this.emitTunnelRegistered(info, undefined, sessionId);
            }
        }
    }

    private getSessionMap(sessionId: string): Map<number, TunnelInfo> {
        let map = this.sessionTunnels.get(sessionId);
        if (!map) {
            map = new Map<number, TunnelInfo>();
            this.sessionTunnels.set(sessionId, map);
        }
        return map;
    }

    private incRef(port: number): void {
        this.portRefCount.set(port, (this.portRefCount.get(port) ?? 0) + 1);
    }

    private decRef(port: number): void {
        const count = (this.portRefCount.get(port) ?? 0) - 1;
        if (count <= 0) {
            this.portRefCount.delete(port);
            this.tunnelClient?.unexposePort(port);
            logInfo(`[tunnel] unexposed port ${port}`);
            this.emitTunnelRemoved(port);
        } else {
            this.portRefCount.set(port, count);
        }
    }

    private emitTunnelRegistered(info: TunnelInfo, requestId?: string, sessionId?: string): void {
        if (!this.socket) return;
        (this.socket as any).emit("service_message", {
            serviceId: "tunnel",
            type: "tunnel_registered",
            ...(requestId ? { requestId } : {}),
            ...(sessionId ? { sessionId } : {}),
            payload: info,
        } satisfies ServiceEnvelope);
    }

    private emitTunnelRemoved(port: number): void {
        if (!this.socket) return;
        (this.socket as any).emit("service_message", {
            serviceId: "tunnel",
            type: "tunnel_removed",
            payload: { port },
        } satisfies ServiceEnvelope);
    }

    private emitTunnelError(requestId: string | undefined, sessionId: string | undefined, error: string): void {
        if (!this.socket) return;
        (this.socket as any).emit("service_message", {
            serviceId: "tunnel",
            type: "tunnel_error",
            ...(requestId ? { requestId } : {}),
            ...(sessionId ? { sessionId } : {}),
            payload: { error },
        } satisfies ServiceEnvelope);
    }

    private handleList(sessionId: string | undefined, requestId?: string): void {
        if (!this.socket) return;

        const tunnels: TunnelInfo[] = [];
        // Pinned runner-level ports are shared with all sessions.
        tunnels.push(...this.pinnedTunnels.values());
        // Session-scoped ports are private to the requesting session.
        if (sessionId) {
            const sessionMap = this.sessionTunnels.get(sessionId);
            if (sessionMap) tunnels.push(...sessionMap.values());
        }

        (this.socket as any).emit("service_message", {
            serviceId: "tunnel",
            type: "tunnel_list_result",
            requestId,
            ...(sessionId ? { sessionId } : {}),
            payload: { tunnels },
        } satisfies ServiceEnvelope);
    }

    private handleExpose(
        sessionId: string | undefined,
        requestId: string | undefined,
        payload: { port: number; name?: string },
    ): void {
        if (!this.socket) return;
        const { port, name } = payload;

        if (!port || port < 1 || port > 65535) {
            this.emitTunnelError(requestId, sessionId, `Invalid port: ${port}`);
            return;
        }
        if (!sessionId) {
            this.emitTunnelError(requestId, sessionId, "Missing sessionId: tunnel_expose must be session-scoped");
            return;
        }

        const sessionMap = this.getSessionMap(sessionId);
        const existing = sessionMap.get(port) ?? this.pinnedTunnels.get(port);
        const info: TunnelInfo = {
            port,
            ...(name ? { name } : existing?.name ? { name: existing.name } : {}),
            url: `/tunnel/${port}`,
        };

        const isNewOwner = !sessionMap.has(port);
        sessionMap.set(port, info);
        if (isNewOwner) this.incRef(port);

        this.tunnelClient?.exposePort(port);
        logInfo(`[tunnel] exposed port ${port}${info.name ? ` (${info.name})` : ""} for session ${sessionId}`);
        this.emitTunnelRegistered(info, requestId, sessionId);
    }

    private handleUnexpose(
        sessionId: string | undefined,
        requestId: string | undefined,
        payload: { port: number },
    ): void {
        if (!this.socket) return;
        const { port } = payload;

        if (!port || port < 1 || port > 65535) {
            this.emitTunnelError(requestId, sessionId, `Invalid port: ${port}`);
            return;
        }
        if (!sessionId) {
            this.emitTunnelError(requestId, sessionId, "Missing sessionId: tunnel_unexpose must be session-scoped");
            return;
        }

        const removed = this.removeSessionPort(sessionId, port);
        if (!removed) {
            this.emitTunnelError(requestId, sessionId, `Port ${port} is not exposed by this session`);
            return;
        }

        // If the port is still exposed by other sessions, only notify the
        // requesting session. If it was fully unexposed, broadcast so every
        // session drops it from its UI.
        if (this.portRefCount.has(port)) {
            (this.socket as any).emit("service_message", {
                serviceId: "tunnel",
                type: "tunnel_removed",
                requestId,
                sessionId,
                payload: { port },
            } satisfies ServiceEnvelope);
        }
    }

    private removeSessionPort(sessionId: string, port: number): boolean {
        const sessionMap = this.sessionTunnels.get(sessionId);
        if (!sessionMap || !sessionMap.has(port)) return false;

        sessionMap.delete(port);
        if (sessionMap.size === 0) this.sessionTunnels.delete(sessionId);
        this.decRef(port);
        return true;
    }
}
