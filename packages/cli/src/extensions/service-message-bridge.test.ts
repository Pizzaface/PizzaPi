import { describe, expect, test } from "bun:test";
import { createServiceMessageBridgeExtension } from "./service-message-bridge.js";

interface Emitted {
    event: string;
    payload: any;
}

/** Minimal pi stand-in: a real-enough event bus plus the lifecycle hooks we use. */
function makePi() {
    const busHandlers = new Map<string, ((data: unknown) => void)[]>();
    const lifecycle = new Map<string, ((event: unknown) => void)[]>();
    const emitted: Emitted[] = [];
    return {
        emitted,
        events: {
            emit(channel: string, data: unknown) {
                for (const h of busHandlers.get(channel) ?? []) h(data);
            },
            on(channel: string, handler: (data: unknown) => void) {
                const list = busHandlers.get(channel) ?? [];
                list.push(handler);
                busHandlers.set(channel, list);
                return () => busHandlers.set(channel, (busHandlers.get(channel) ?? []).filter((h) => h !== handler));
            },
        },
        on(event: string, handler: (event: unknown) => void) {
            const list = lifecycle.get(event) ?? [];
            list.push(handler);
            lifecycle.set(event, list);
        },
        fire(event: string, data: unknown = {}) {
            for (const h of lifecycle.get(event) ?? []) h(data);
        },
        busListenerCount: (channel: string) => (busHandlers.get(channel) ?? []).length,
        socket: {
            emit(event: string, payload: any) {
                emitted.push({ event, payload });
            },
        },
    };
}

function install(pi: ReturnType<typeof makePi>, sessionId: string | null = "sess-1", connected = true) {
    const factory = createServiceMessageBridgeExtension({
        getRelaySocket: (() => (connected ? { socket: pi.socket } : null)) as any,
        getRelaySessionId: (() => sessionId) as any,
        newId: () => "id-1",
    });
    factory(pi as any);
}

describe("serviceMessageBridgeExtension", () => {
    test("relays a bus message to the daemon, stamping id and sessionId", () => {
        const pi = makePi();
        install(pi);

        pi.events.emit("pizzapi:service_message", {
            serviceId: "connector",
            type: "session_post",
            payload: { content: "hello" },
        });

        expect(pi.emitted).toHaveLength(1);
        expect(pi.emitted[0].event).toBe("service_message");
        expect(pi.emitted[0].payload).toEqual({
            serviceId: "connector",
            type: "session_post",
            payload: { content: "hello", id: "id-1", sessionId: "sess-1" },
        });
    });

    test("a package cannot spoof another session by supplying its own sessionId", () => {
        const pi = makePi();
        install(pi);

        pi.events.emit("pizzapi:service_message", {
            serviceId: "connector",
            type: "session_post",
            payload: { sessionId: "victim", id: "forged" },
        });

        expect(pi.emitted[0].payload.payload).toEqual({ sessionId: "sess-1", id: "id-1" });
    });

    test("drops malformed messages and non-object payloads", () => {
        const pi = makePi();
        install(pi);

        pi.events.emit("pizzapi:service_message", undefined);
        pi.events.emit("pizzapi:service_message", { serviceId: "", type: "x" });
        pi.events.emit("pizzapi:service_message", { serviceId: "connector", type: "" });
        pi.events.emit("pizzapi:service_message", { serviceId: "connector", type: 7 });
        expect(pi.emitted).toHaveLength(0);

        pi.events.emit("pizzapi:service_message", { serviceId: "connector", type: "ping", payload: [1, 2] });
        expect(pi.emitted[0].payload.payload).toEqual({ id: "id-1", sessionId: "sess-1" });
    });

    test("no-ops while the relay is unavailable instead of throwing into the turn", () => {
        const disconnected = makePi();
        install(disconnected, "sess-1", false);
        disconnected.events.emit("pizzapi:service_message", { serviceId: "c", type: "t" });
        expect(disconnected.emitted).toHaveLength(0);

        const unregistered = makePi();
        install(unregistered, null);
        unregistered.events.emit("pizzapi:service_message", { serviceId: "c", type: "t" });
        expect(unregistered.emitted).toHaveLength(0);
    });

    test("unsubscribes on session_shutdown so /reload does not stack listeners", () => {
        const pi = makePi();
        install(pi);
        expect(pi.busListenerCount("pizzapi:service_message")).toBe(1);

        pi.fire("session_shutdown", { reason: "reload" });
        expect(pi.busListenerCount("pizzapi:service_message")).toBe(0);

        pi.events.emit("pizzapi:service_message", { serviceId: "c", type: "t" });
        expect(pi.emitted).toHaveLength(0);
    });
});
