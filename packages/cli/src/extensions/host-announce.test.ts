import { describe, test, expect } from "bun:test";
import { isPizzaPiHostInfo, detectPizzaPiHost, onPizzaPiHost, sendServiceMessage } from "@pizzapi/extension-sdk";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { hostAnnounceExtension, buildHostInfo } from "./host-announce.js";
import { createServiceMessageBridgeExtension } from "./service-message-bridge.js";

/** Minimal synchronous pi.events fake — enough to exercise probe/ready semantics. */
function fakePiEvents() {
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    return {
        events: {
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

    test("onPizzaPiHost() delivers via the ready event when subscribed BEFORE the host factory runs", async () => {
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

        // The ready emit is deferred to the next macrotask so capability
        // bridges (service-message-bridge, etc.) install their listeners first.
        expect(delivered).toBeUndefined();
        await new Promise((resolve) => setImmediate(resolve));
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

    test("a package reacting to host:ready can send a service message that is NOT dropped", async () => {
        // Mirrors the real ordering: the package factory runs first (subscribes
        // via onPizzaPiHost), then PizzaPi inline factories run in order —
        // host-announce first, service-message-bridge later. The ready emit is
        // deferred to the next macrotask so the bridge's listener is installed
        // before the package's host:ready callback fires. With the old
        // synchronous emit, sendServiceMessage() would fire before the bridge
        // subscribed and the message would be silently dropped.
        const emitted: Array<{ event: string; payload: any }> = [];
        const busHandlers = new Map<string, Array<(data: unknown) => void>>();
        const pi = {
            events: {
                on(type: string, handler: (data: unknown) => void) {
                    const arr = busHandlers.get(type) ?? [];
                    arr.push(handler);
                    busHandlers.set(type, arr);
                    return () => busHandlers.set(type, (busHandlers.get(type) ?? []).filter((h) => h !== handler));
                },
                emit(type: string, payload: unknown) {
                    for (const h of busHandlers.get(type) ?? []) h(payload);
                },
            },
            on(_type: string, _handler: () => void) {},
            socket: {
                emit(event: string, payload: any) {
                    emitted.push({ event, payload });
                },
            },
        };

        // 1. Package extension factory runs first (before PizzaPi inline factories).
        onPizzaPiHost(pi as any, () => {
            sendServiceMessage(pi as any, "connector", "session_post", { content: "hello" });
        });

        // 2. PizzaPi inline factories run in order: host-announce, then the bridge.
        hostAnnounceExtension(pi as any);
        createServiceMessageBridgeExtension({
            getRelaySocket: (() => ({ socket: pi.socket })) as any,
            getRelaySessionId: (() => "sess-1") as any,
            newId: () => "id-1",
        })(pi as any);

        // 3. Ready fires on the next macrotask, after the bridge listener is installed.
        await new Promise((resolve) => setImmediate(resolve));

        expect(emitted).toHaveLength(1);
        expect(emitted[0].event).toBe("service_message");
        expect(emitted[0].payload.serviceId).toBe("connector");
        expect(emitted[0].payload.type).toBe("session_post");
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
