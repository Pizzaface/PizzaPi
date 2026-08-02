/**
 * PizzaPi host capability announcement (docs/specs/pi-pizzapi-overlay.md
 * §9.3) — the daemon-side counterpart of `@pizzapi/extension-sdk`'s
 * `detectPizzaPiHost()`/`onPizzaPiHost()`.
 *
 * Pi 0.82.1 loads configured package extensions BEFORE PizzaPi's inline
 * factories, so a package extension's factory body cannot rely on a
 * synchronous `pizzapi:host:probe` reply arriving before its own setup
 * finishes — this extension hasn't registered its probe listener yet at
 * that point. That's exactly why the SDK also exposes `pizzapi:host:ready`:
 * a package that calls `onPizzaPiHost()` during its factory registers a
 * `pizzapi:host:ready` listener FIRST (its factory already ran), so when
 * this factory runs afterward and emits `pizzapi:host:ready`, every such
 * listener — already subscribed — receives it synchronously.
 *
 * Must be registered as early as possible among PizzaPi's own inline
 * factories (see factories.ts) so the ready announcement isn't delayed
 * behind unrelated PizzaPi setup work.
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PizzaPiHostInfo } from "@pizzapi/extension-sdk";

/**
 * Capabilities a package can rely on when this host responds. Kept as a
 * flat list (not versioned per-capability) — v1 hosts support the full set.
 */
const HOST_CAPABILITIES: readonly string[] = [
    "services",
    "agents",
    "rules",
    "mcp",
    "panels",
    "triggers",
    "sigils",
    // Session extensions can reach their daemon service via
    // `sendServiceMessage()` — see service-message-bridge.ts.
    "serviceMessages",
];

export function buildHostInfo(): PizzaPiHostInfo {
    return { apiVersion: 1, capabilities: HOST_CAPABILITIES };
}

export const hostAnnounceExtension: ExtensionFactory = (pi) => {
    const hostInfo = buildHostInfo();

    // Synchronous probe responder — per spec §9.3 this MUST reply
    // synchronously; pi's event bus invokes listeners before emit() returns,
    // but only for this synchronous tick.
    //
    // pi's real `createEventBus()` (core/event-bus.ts) backs `pi.events` with
    // a single Node `EventEmitter` that OUTLIVES a `/reload` — reload()
    // re-invokes every inline extension factory (including this one) against
    // the SAME bus (see resource-loader.ts reload() -> loadExtensionFactories()),
    // so a probe listener registered here and never removed would
    // accumulate one more listener per reload for the life of the process.
    // `.on()` returns pi's own unsubscribe function for exactly this reason
    // — capture it and remove the listener on session_shutdown, which pi
    // fires for the CURRENT extension runner before reload() re-runs
    // factories (agent-session.ts reload(): emitSessionShutdownEvent(...)
    // happens before this._resourceLoader.reload()).
    const unsubscribeProbe = pi.events.on("pizzapi:host:probe", (payload: unknown) => {
        const respond = (payload as { respond?: (value: unknown) => void } | undefined)?.respond;
        if (typeof respond === "function") respond(hostInfo);
    });

    // Announce readiness now, while still inside factory execution — any
    // package extension whose factory already ran and subscribed to
    // "pizzapi:host:ready" receives this synchronously.
    pi.events.emit("pizzapi:host:ready", hostInfo);

    pi.on("session_shutdown", () => {
        unsubscribeProbe();
    });
};
