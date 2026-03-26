import type { Socket } from "socket.io-client";
import { logError } from "./logger.js";

/**
 * Interface for runner-side service handlers.
 * Each service registers its socket event handlers in init() and cleans up in dispose().
 */
export interface ServiceHandler {
    /** Unique service identifier (e.g., "terminal", "file-explorer", "git") */
    readonly id: string;

    /**
     * Initialize the service — register socket event listeners and perform setup.
     * Called once per socket connection.
     */
    init(socket: Socket, options: ServiceInitOptions): void;

    /**
     * Clean up the service — kill processes, clear state, remove listeners.
     * Called on socket disconnect or daemon shutdown.
     */
    dispose(): void;
}

export interface ServiceInitOptions {
    isShuttingDown: () => boolean;
    /** Call to announce a panel HTTP server port. Only provided to services with a panel manifest. */
    announcePanel?: (port: number) => void;
}

/**
 * Generic relay protocol envelope.
 * All service messages conceptually flow through this shape, even though
 * the actual socket events don't change in Phase 1 (relay unchanged).
 */
export interface ServiceEnvelope {
    serviceId: string;
    type: string;
    requestId?: string;
    payload: unknown;
}

/**
 * Registry of service handlers. The daemon uses this to register and dispose services.
 */
export class ServiceRegistry {
    private readonly handlers = new Map<string, ServiceHandler>();

    register(handler: ServiceHandler): void {
        if (this.handlers.has(handler.id)) {
            throw new Error(`ServiceRegistry: duplicate service id "${handler.id}"`);
        }
        this.handlers.set(handler.id, handler);
    }

    get(id: string): ServiceHandler | undefined {
        return this.handlers.get(id);
    }

    getAll(): ServiceHandler[] {
        return Array.from(this.handlers.values());
    }

    /**
     * Initialize all registered services against the given socket.
     */
    initAll(socket: Socket, options: ServiceInitOptions): void {
        for (const handler of this.handlers.values()) {
            handler.init(socket, options);
        }
    }

    /**
     * Dispose all registered services (e.g., on disconnect or shutdown).
     */
    disposeAll(): void {
        for (const handler of this.handlers.values()) {
            try {
                handler.dispose();
            } catch (err) {
                logError(`[ServiceRegistry] dispose error for service "${handler.id}": ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
            }
        }
    }
}
