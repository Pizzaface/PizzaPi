import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// ── Stubs for the two things the gate reads ──────────────────────────────────
// Local room membership (sync, via the io adapter) and the cluster-wide count.

let localRoomSizes = new Map<string, number>();
let clusterCount: number | Error | "unknown" = 0;
let clusterCalls = 0;
let ioAvailable = true;

mock.module("../../sio-registry/context.js", () => ({
    getIo: () => {
        if (!ioAvailable) return undefined;
        return {
            of: () => ({
                adapter: {
                    rooms: {
                        get: (room: string) =>
                            localRoomSizes.has(room)
                                ? new Set(Array.from({ length: localRoomSizes.get(room)! }, (_, i) => `s${i}`))
                                : undefined,
                    },
                },
            }),
        };
    },
    viewerSessionRoom: (sessionId: string) => `viewer:${sessionId}`,
}));

mock.module("../../sio-registry/sessions.js", () => ({
    getViewerCount: async (_sessionId: string) => {
        clusterCalls++;
        if (clusterCount instanceof Error) throw clusterCount;
        if (clusterCount === "unknown") return { kind: "unknown" };
        return { kind: "count", count: clusterCount };
    },
}));

const { isDeltaEvent, shouldPublishDelta, resetViewerGate, forgetViewerGate } = await import("./viewer-gate.js");

/** Let the fire-and-forget cluster refresh settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    localRoomSizes = new Map();
    clusterCount = 0;
    clusterCalls = 0;
    ioAvailable = true;
    resetViewerGate();
});

afterEach(() => {
    resetViewerGate();
});

describe("isDeltaEvent", () => {
    test("only the two pure-animation event types are gated", () => {
        expect(isDeltaEvent("message_update")).toBe(true);
        expect(isDeltaEvent("tool_execution_update")).toBe(true);

        // Everything else feeds durable state, push, or meta rooms.
        for (const type of [
            "message_end",
            "turn_end",
            "agent_end",
            "session_active",
            "tool_execution_start",
            "tool_execution_end",
            "cli_error",
            "heartbeat",
        ]) {
            expect(isDeltaEvent(type)).toBe(false);
        }
        expect(isDeltaEvent(undefined)).toBe(false);
        expect(isDeltaEvent(123)).toBe(false);
    });
});

describe("shouldPublishDelta", () => {
    test("publishes immediately when a viewer is attached to this server", async () => {
        localRoomSizes.set("viewer:s1", 1);
        expect(shouldPublishDelta("s1")).toBe(true);
        // Fast path must not touch the cluster query at all.
        expect(clusterCalls).toBe(0);
    });

    test("suppresses only after a confirmed cluster-wide zero", async () => {
        // First call has no cached count yet — fail open.
        expect(shouldPublishDelta("s1")).toBe(true);
        await settle();

        // Now the refresh has confirmed nobody is watching anywhere.
        expect(shouldPublishDelta("s1")).toBe(false);
    });

    test("publishes when a viewer is attached to another server", async () => {
        clusterCount = 1;
        shouldPublishDelta("s1");
        await settle();
        expect(shouldPublishDelta("s1")).toBe(true);
    });

    test("fails open when the cluster query throws", async () => {
        clusterCount = new Error("redis down");
        shouldPublishDelta("s1");
        await settle();
        expect(shouldPublishDelta("s1")).toBe(true);
    });

    test("fails open when cluster presence is unknown", async () => {
        clusterCount = "unknown";
        shouldPublishDelta("s1");
        await settle();
        expect(shouldPublishDelta("s1")).toBe(true);
    });

    test("fails open when io is unavailable and the count never resolves", () => {
        ioAvailable = false;
        expect(shouldPublishDelta("s1")).toBe(true);
    });

    test("a viewer attaching locally overrides a cached zero immediately", async () => {
        shouldPublishDelta("s1");
        await settle();
        expect(shouldPublishDelta("s1")).toBe(false);

        // No waiting for the TTL — the local check runs first.
        localRoomSizes.set("viewer:s1", 1);
        expect(shouldPublishDelta("s1")).toBe(true);
    });

    test("caches the cluster count instead of querying per delta", async () => {
        shouldPublishDelta("s1");
        await settle();
        const afterFirst = clusterCalls;

        for (let i = 0; i < 50; i++) shouldPublishDelta("s1");
        expect(clusterCalls).toBe(afterFirst);
    });

    test("forgetViewerGate drops cached presence so the next call fails open", async () => {
        shouldPublishDelta("s1");
        await settle();
        expect(shouldPublishDelta("s1")).toBe(false);

        forgetViewerGate("s1");
        expect(shouldPublishDelta("s1")).toBe(true);
    });

    test("sessions are gated independently", async () => {
        localRoomSizes.set("viewer:watched", 1);
        shouldPublishDelta("unwatched");
        await settle();

        expect(shouldPublishDelta("watched")).toBe(true);
        expect(shouldPublishDelta("unwatched")).toBe(false);
    });
});
