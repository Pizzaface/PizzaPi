import type { Socket } from "socket.io-client";
import type { PizzaPiSocket, ServiceHandler, ServiceInitOptions } from "@pizzapi/extension-sdk";
import { logError } from "./logger.js";

// Canonical public contract lives in @pizzapi/extension-sdk. Re-exported here
// so existing internal `./service-handler.js` imports keep working unchanged.
export type {
  PizzaPiSocket,
  ServiceHandler,
  ServiceInitOptions,
  ServiceEnvelope,
  ReconcileResult,
  ReconcileOptions,
  TriggerSubscriptionEntry,
  TriggerSubscriptionDelta,
} from "@pizzapi/extension-sdk";

/**
 * Registry of service handlers. The daemon uses this to register and dispose services.
 * Host-side only — not part of the public extension-sdk contract.
 */
export class ServiceRegistry {
    private readonly handlers = new Map<string, ServiceHandler>();

    register(handler: ServiceHandler): void {
        if (this.handlers.has(handler.id)) {
            throw new Error(`ServiceRegistry: duplicate service id "${handler.id}"`);
        }
        this.handlers.set(handler.id, handler);
    }

    unregister(id: string): boolean {
        return this.handlers.delete(id);
    }

    has(id: string): boolean {
        return this.handlers.has(id);
    }

    get(id: string): ServiceHandler | undefined {
        return this.handlers.get(id);
    }

    getAll(): ServiceHandler[] {
        return Array.from(this.handlers.values());
    }

    /**
     * Initialize all registered services against the given socket.
     * The real runner socket is typed against the strict runner namespace
     * event maps; service handlers use the narrower @pizzapi/extension-sdk
     * `PizzaPiSocket` contract, so the widening happens once here.
     */
    initAll(socket: Socket, options: ServiceInitOptions): void {
        const pizzapiSocket = socket as unknown as PizzaPiSocket;
        for (const handler of this.handlers.values()) {
            handler.init(pizzapiSocket, options);
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
