/**
 * Tests for the received → delivered trigger state split and per-mode batching.
 *
 * Regression (P1): trackReceivedTrigger recorded the trigger ID at receipt,
 * BEFORE the debounced sendUserMessage injected it into the agent. If that
 * injection failed, the relay's redelivery of the same triggerId was dropped
 * as a duplicate — permanent trigger loss. markTriggerInjectionFailed must
 * remove the dedupe entry so redelivery is accepted, and markTriggerDelivered
 * must pin the entry so a late injection-failure signal can't evict a
 * successfully delivered trigger.
 *
 * Regression (P2): a single steering trigger upgraded the whole 80ms debounce
 * batch to "steer". partitionTriggerBatchByDeliveryMode must keep the modes
 * separate.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
    trackReceivedTrigger,
    receivedTriggers,
    markTriggerHandled,
    markTriggerDelivered,
    markTriggerInjectionFailed,
    partitionTriggerBatchByDeliveryMode,
} from "./extension.js";

describe("received vs delivered trigger state", () => {
    beforeEach(() => {
        receivedTriggers.clear();
    });

    test("injection failure removes the dedupe entry so redelivery is accepted", () => {
        expect(trackReceivedTrigger("t1", "child-1", "session_complete")).toBe(true);
        // Duplicate while pending is still rejected.
        expect(trackReceivedTrigger("t1", "child-1", "session_complete")).toBe(false);

        // sendUserMessage failed — the agent never saw the trigger.
        markTriggerInjectionFailed("t1");
        expect(receivedTriggers.has("t1")).toBe(false);

        // The relay redelivers the same triggerId: it must be accepted, not
        // dropped as a duplicate (that was the permanent-loss bug).
        expect(trackReceivedTrigger("t1", "child-1", "session_complete")).toBe(true);
    });

    test("delivered triggers are immune to a late injection-failure signal", () => {
        trackReceivedTrigger("t2", "child-1", "session_complete");
        markTriggerDelivered("t2");
        // A stale failure signal (e.g. from a racing batch) must not evict a
        // delivered trigger — it's still needed for response routing.
        markTriggerInjectionFailed("t2");
        expect(receivedTriggers.has("t2")).toBe(true);
        expect(receivedTriggers.get("t2")?.delivered).toBe(true);
        // And it still dedupes redelivery.
        expect(trackReceivedTrigger("t2", "child-1", "session_complete")).toBe(false);
    });

    test("handled triggers stay tombstoned even after injection-failure signal", () => {
        trackReceivedTrigger("t3", "child-1", "session_complete");
        markTriggerDelivered("t3");
        markTriggerHandled("t3");
        markTriggerInjectionFailed("t3");
        // The tombstone from markTriggerHandled still blocks re-tracking.
        expect(trackReceivedTrigger("t3", "child-1", "session_complete")).toBe(false);
    });

    test("injection failure for an unknown trigger is a no-op", () => {
        expect(() => markTriggerInjectionFailed("nope")).not.toThrow();
    });
});

describe("partitionTriggerBatchByDeliveryMode", () => {
    test("mixed batch splits into steer and followUp groups, steer first", () => {
        const batch = [
            { deliverAs: "followUp" as const, id: "a" },
            { deliverAs: "steer" as const, id: "b" },
            { deliverAs: "followUp" as const, id: "c" },
        ];
        const groups = partitionTriggerBatchByDeliveryMode(batch);
        expect(groups).toHaveLength(2);
        expect(groups[0].deliverAs).toBe("steer");
        expect(groups[0].items.map((i) => i.id)).toEqual(["b"]);
        // followUp triggers are NOT upgraded to steer by sharing the window.
        expect(groups[1].deliverAs).toBe("followUp");
        expect(groups[1].items.map((i) => i.id)).toEqual(["a", "c"]);
    });

    test("homogeneous batch yields a single group", () => {
        const groups = partitionTriggerBatchByDeliveryMode([
            { deliverAs: "followUp" as const },
            { deliverAs: "followUp" as const },
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0].deliverAs).toBe("followUp");
        expect(groups[0].items).toHaveLength(2);
    });

    test("empty batch yields no groups", () => {
        expect(partitionTriggerBatchByDeliveryMode([])).toEqual([]);
    });
});
