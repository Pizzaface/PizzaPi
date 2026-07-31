import { describe, test, expect } from "bun:test";
import { isPizzaPiHostInfo, detectPizzaPiHost, onPizzaPiHost } from "@pizzapi/extension-sdk";
import { hostAnnounceExtension, buildHostInfo } from "./host-announce.js";

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
});
