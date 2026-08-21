import { describe, test, expect } from "bun:test";
import { isPizzaPiHostInfo, detectPizzaPiHost, onPizzaPiHost } from "@pizzapi/extension-sdk";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { hostAnnounceExtension, buildHostInfo } from "./host-announce.js";
import { serviceMessageBridgeExtension } from "./service-message-bridge.js";

/** Minimal synchronous pi.events fake — enough to exercise probe/ready semantics. */
function fakePiEvents() {
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    return {
        events: {
            listeners,
            on(type: string, handler: (payload: unknown) => void) {
                const arr = listeners.get(type) ?? [];
                arr.push(handler);
                listeners.set(type, arr);
                return () => {
                    const idx = arr.indexOf(handler);
                    if (idx >= 0) arr.splice(idx, 1);
                };
            },
            emit(type: string, payload: unknown) {
                for (const handler of listeners.get(type) ?? []) handler(payload);
            },
        },
        // Lifecycle events (session_shutdown, etc.) are a separate mechanism
        // from the `.events` pub/sub bus — hostAnnounceExtension only needs
        // session_shutdown, so that's all this fake wires up.
        on(_type: string, _handler: () => void) {},
    };
}

describe("hostAnnounceExtension", () => {
    test("buildHostInfo() returns a valid PizzaPiHostInfo", () => {
        const info = buildHostInfo();
        expect(isPizzaPiHostInfo(info)).toBe(true);
        expect(info.apiVersion).toBe(1);
        expect(info.capabilities.length).toBeGreaterThan(0);
    });

    test("detectPizzaPiHost() succeeds once the extension has registered its probe listener", () => {
        const pi = fakePiEvents();
        expect(detectPizzaPiHost(pi as any)).toBeUndefined(); // no host yet — vanilla pi
        hostAnnounceExtension(pi as any);
        expect(detectPizzaPiHost(pi as any)).toEqual(buildHostInfo());
    });

    test("onPizzaPiHost() delivers via the ready event when subscribed BEFORE the host factory runs", () => {
        // Mirrors the real ordering constraint: package extensions run their
        // factory (and may call onPizzaPiHost) before PizzaPi's own inline
        // host-announce factory runs.
        const pi = fakePiEvents();
        let delivered: unknown;
        onPizzaPiHost(pi as any, (host) => {
            delivered = host;
        });
        expect(delivered).toBeUndefined();

        hostAnnounceExtension(pi as any);

        expect(delivered).toEqual(buildHostInfo());
    });

    test("onPizzaPiHost() delivers immediately via synchronous probe when subscribed AFTER the host factory runs", () => {
        const pi = fakePiEvents();
        hostAnnounceExtension(pi as any);

        let delivered: unknown;
        onPizzaPiHost(pi as any, (host) => {
            delivered = host;
        });

        expect(delivered).toEqual(buildHostInfo());
    });

    /**
     * Build a minimal but REAL-bus pi fake: `.events` is backed by pi's own
     * `createEventBus()` (real Node EventEmitter under the hood), not a
     * hand-rolled listeners map — so this test actually characterizes the
     * accumulation behavior a fake could silently diverge from. `.on()` is a
     * small session-lifecycle-event shim (session_shutdown only, which is
     * all this extension uses) that hands back the same real emitter's
     * listener count for assertions.
     */
    function realBusPi() {
        const bus = createEventBus();
        const shutdownHandlers: Array<() => void> = [];
        const pi = {
            events: bus,
            on(event: string, handler: () => void) {
                if (event === "session_shutdown") shutdownHandlers.push(handler);
            },
        };
        return {
            pi,
            bus,
            fireShutdown: () => { for (const h of shutdownHandlers.splice(0)) h(); },
        };
    }

    test("host ready is emitted before the service-message-bridge listener exists", () => {
        // Mirrors the real factory ordering in factories.ts:
        // hostAnnounceExtension is index 0; serviceMessageBridgeExtension is
        // registered later. Because package extensions run BEFORE inline
        // factories, their onPizzaPiHost() callback fires during hostAnnounce
        // — while the bridge listener that would handle sendServiceMessage()
        // is still unattached.
        const pi = fakePiEvents();
        let readyDelivered = false;
        let serviceListenersAtReady = 0;

        onPizzaPiHost(pi as any, () => {
            readyDelivered = true;
            // A package extension that uses the advertised "serviceMessages"
            // capability immediately sends a service message. At this moment
            // the service-message-bridge listener has not been registered yet.
            serviceListenersAtReady = (pi.events.listeners.get("pizzapi:service_message") ?? []).length;
            pi.events.emit("pizzapi:service_message", { serviceId: "discord", type: "ready", payload: {} });
        });

        hostAnnounceExtension(pi as any);
        expect(readyDelivered).toBe(true);
        expect(serviceListenersAtReady).toBe(0); // bridge isn't bound yet

        serviceMessageBridgeExtension(pi as any);
        expect((pi.events.listeners.get("pizzapi:service_message") ?? []).length).toBeGreaterThan(0);
    });

    test("session_shutdown removes the probe listener from the real pi event bus (no accumulation across reloads)", () => {
        const { pi, bus, fireShutdown } = realBusPi();

        // Simulate `/reload`: pi re-invokes the SAME inline factory against the
        // SAME bus on every reload (resource-loader.js loadExtensionFactories()
        // runs again), firing session_shutdown for the previous runner first.
        for (let i = 0; i < 3; i++) {
            hostAnnounceExtension(pi as any);
            expect(detectPizzaPiHost(pi as any)).toEqual(buildHostInfo());
            fireShutdown();
        }

        // After the last shutdown, the probe listener must be gone — a probe
        // now gets no response, proving each factory run's listener was
        // actually removed rather than accumulating one per iteration.
        expect(detectPizzaPiHost(pi as any)).toBeUndefined();
    });
});
