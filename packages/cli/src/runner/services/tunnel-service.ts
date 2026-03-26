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

    private tunnels = new Map<number, TunnelInfo>();
    private socket: Socket | null = null;
    private tunnelClient: TunnelClient | null = null;
    private _onServiceMessage: ((envelope: ServiceEnvelope) => void) | null = null;

    setTunnelClient(client: TunnelClient | null): void {
        this.tunnelClient = client;
        if (!client) return;

        for (const port of this.tunnels.keys()) {
            client.exposePort(port);
        }
    }

    init(socket: Socket, { isShuttingDown }: ServiceInitOptions): void {
        this.socket = socket;

        this._onServiceMessage = (envelope: ServiceEnvelope) => {
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
     */
    registerPort(port: number, name?: string): void {
        const info: TunnelInfo = {
            port,
            ...(name ? { name } : {}),
            url: `/tunnel/${port}`,
            pinned: true,
        };
        this.tunnels.set(port, info);
        this.tunnelClient?.exposePort(port);
        logInfo(`[tunnel] auto-registered panel port ${port}${name ? ` (${name})` : ""}`);
        this.emitTunnelRegistered(info);
    }

    private syncSocketState(): void {
        for (const info of this.tunnels.values()) {
            this.emitTunnelRegistered(info);
        }
    }

    private emitTunnelRegistered(info: TunnelInfo, requestId?: string): void {
        if (!this.socket) return;
        (this.socket as any).emit("service_message", {
            serviceId: "tunnel",
            type: "tunnel_registered",
            ...(requestId ? { requestId } : {}),
            payload: info,
        } satisfies ServiceEnvelope);
    }

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

        const existing = this.tunnels.get(port);
        const info: TunnelInfo = {
            port,
            ...(name ? { name } : existing?.name ? { name: existing.name } : {}),
            url: `/tunnel/${port}`,
            ...(existing?.pinned ? { pinned: true } : {}),
        };
        this.tunnels.set(port, info);
        this.tunnelClient?.exposePort(port);
        logInfo(`[tunnel] exposed port ${port}${info.name ? ` (${info.name})` : ""}`);
        this.emitTunnelRegistered(info, requestId);
    }

    private handleUnexpose(payload: { port: number }): void {
        if (!this.socket) return;
        const { port } = payload;

        if (!this.tunnels.delete(port)) return;

        this.tunnelClient?.unexposePort(port);
        logInfo(`[tunnel] unexposed port ${port}`);
        (this.socket as any).emit("service_message", {
            serviceId: "tunnel",
            type: "tunnel_removed",
            payload: { port },
        } satisfies ServiceEnvelope);
    }
}
