/**
 * Session -> runner-service message bridge.
 *
 * Runner services live in the daemon and see nothing of a session's in-process
 * events (tool calls, assistant messages, renames). A package that needs those
 * ships a session-side pi extension and forwards what it wants over this
 * bridge: emit `pizzapi:service_message` on pi's shared event bus (the typed
 * entry point is `sendServiceMessage()` in `@pizzapi/extension-sdk`) and this
 * extension relays it to the daemon as a `service_message` envelope.
 *
 * PizzaPi core carries no knowledge of any individual connector: the Discord
 * bridge's mirror, its envelope shapes, and its rendering all live in the
 * Discord package. Adding a connector is a new package, zero edits here.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
    getRelaySocket as getRelaySocketDefault,
    getRelaySessionId as getRelaySessionIdDefault,
} from "./remote.js";

export interface ServiceMessageBridgeDeps {
    getRelaySocket: typeof getRelaySocketDefault;
    getRelaySessionId: typeof getRelaySessionIdDefault;
    newId: () => string;
}

const defaultDeps: ServiceMessageBridgeDeps = {
    getRelaySocket: getRelaySocketDefault,
    getRelaySessionId: getRelaySessionIdDefault,
    newId: randomUUID,
};

export function createServiceMessageBridgeExtension(
    deps: ServiceMessageBridgeDeps = defaultDeps,
): ExtensionFactory {
    return (pi) => {
        const unsubscribe = pi.events.on("pizzapi:service_message", (data: unknown) => {
            const msg = data as { serviceId?: unknown; type?: unknown; payload?: unknown } | undefined;
            const serviceId = msg?.serviceId;
            const type = msg?.type;
            if (typeof serviceId !== "string" || !serviceId) return;
            if (typeof type !== "string" || !type) return;
            const payload =
                msg?.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
                    ? (msg.payload as Record<string, unknown>)
                    : {};

            const conn = deps.getRelaySocket();
            const sessionId = deps.getRelaySessionId();
            if (!conn || !sessionId) return;
            try {
                // Fire-and-forget: `id` lets services dedupe at-least-once relay
                // delivery; `sessionId` is stamped by the host so a package can
                // never spoof another session's traffic.
                conn.socket.emit("service_message" as any, {
                    serviceId,
                    type,
                    payload: { ...payload, id: deps.newId(), sessionId },
                });
            } catch {
                // Relay socket mid-reconnect — a dropped message is cosmetic,
                // blocking the turn on service availability is not.
            }
        });

        // pi's event bus outlives /reload and re-runs factories against it, so
        // an un-removed listener accumulates one per reload (see host-announce.ts).
        pi.on("session_shutdown", () => {
            unsubscribe();
        });
    };
}

export const serviceMessageBridgeExtension: ExtensionFactory = createServiceMessageBridgeExtension();
