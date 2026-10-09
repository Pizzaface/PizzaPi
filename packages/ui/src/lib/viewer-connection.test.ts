import { describe, expect, test } from "bun:test";
import {
    shouldEvaluateStaleWatchdog,
    shouldStopViewerReconnect,
    staleWatchdogBackoffMultiplier,
    shouldTriggerStaleWatchdogReconnect,
    shouldForceReconnectOnResume,
} from "./viewer-connection.js";

describe("shouldEvaluateStaleWatchdog", () => {
    test("checks an idle but connected session — heartbeats arrive regardless of agent activity", () => {
        expect(shouldEvaluateStaleWatchdog(true, true)).toBe(true);
    });

    test("skips when there's no active session or the socket thinks it's disconnected", () => {
        expect(shouldEvaluateStaleWatchdog(false, true)).toBe(false);
        expect(shouldEvaluateStaleWatchdog(true, false)).toBe(false);
        expect(shouldEvaluateStaleWatchdog(false, false)).toBe(false);
    });
});

describe("staleWatchdogBackoffMultiplier", () => {
    test("doubles per consecutive unproductive reconnect, capped", () => {
        expect(staleWatchdogBackoffMultiplier(0)).toBe(1);
        expect(staleWatchdogBackoffMultiplier(1)).toBe(2);
        expect(staleWatchdogBackoffMultiplier(2)).toBe(4);
        expect(staleWatchdogBackoffMultiplier(3)).toBe(8);
        expect(staleWatchdogBackoffMultiplier(4)).toBe(8);
        expect(staleWatchdogBackoffMultiplier(10)).toBe(8);
    });

    test("never goes below 1x even for a negative count", () => {
        expect(staleWatchdogBackoffMultiplier(-1)).toBe(1);
    });
});

describe("shouldTriggerStaleWatchdogReconnect — silent runner does not reconnect-loop", () => {
    const BASE_THRESHOLD_MS = 30_000;

    test("fires on the first stale check (no backoff yet)", () => {
        expect(shouldTriggerStaleWatchdogReconnect(31_000, BASE_THRESHOLD_MS, 0)).toBe(true);
    });

    test("after one unproductive reconnect, the same elapsed time no longer trips it", () => {
        // A dead runner's reconnect still resets lastViewerEventAtRef (the
        // server's "connected" ack), so without backoff this elapsed value
        // would trip again on the very next tick — the reconnect-storm bug.
        expect(shouldTriggerStaleWatchdogReconnect(31_000, BASE_THRESHOLD_MS, 1)).toBe(false);
        expect(shouldTriggerStaleWatchdogReconnect(61_000, BASE_THRESHOLD_MS, 1)).toBe(true);
    });

    test("consecutive unproductive reconnects require an ever-longer silence, not a fixed cadence", () => {
        // Simulates a silent runner: every reconnect the watchdog triggers is
        // itself unproductive, so the required silence keeps growing instead
        // of the watchdog firing every ~30s forever.
        let consecutive = 0;
        const requiredSilences: number[] = [];
        for (let tick = 0; tick < 5; tick++) {
            const threshold = BASE_THRESHOLD_MS * staleWatchdogBackoffMultiplier(consecutive);
            requiredSilences.push(threshold);
            expect(shouldTriggerStaleWatchdogReconnect(threshold - 1, BASE_THRESHOLD_MS, consecutive)).toBe(false);
            expect(shouldTriggerStaleWatchdogReconnect(threshold + 1, BASE_THRESHOLD_MS, consecutive)).toBe(true);
            consecutive += 1;
        }
        // Strictly increasing until the cap, never a flat fixed cadence.
        expect(requiredSilences).toEqual([30_000, 60_000, 120_000, 240_000, 240_000]);
    });

    test("a single proof-of-life event resets the count, re-arming the short threshold", () => {
        // consecutiveStaleReconnects resets to 0 in App.tsx once a real event
        // arrives; verify the threshold really does drop back down.
        expect(shouldTriggerStaleWatchdogReconnect(31_000, BASE_THRESHOLD_MS, 0)).toBe(true);
    });
});

describe("shouldForceReconnectOnResume", () => {
    const HEARTBEAT_INTERVAL_MS = 10_000;

    test("does not force a teardown when the last event was recent (harmless foreground blip)", () => {
        const now = 100_000;
        const lastEventAt = now - 5_000; // well under 1.5x the heartbeat interval
        expect(shouldForceReconnectOnResume(lastEventAt, now, HEARTBEAT_INTERVAL_MS)).toBe(false);
    });

    test("forces a teardown once the connection could plausibly be stale", () => {
        const now = 100_000;
        const lastEventAt = now - 16_000; // past 1.5x the heartbeat interval (15s)
        expect(shouldForceReconnectOnResume(lastEventAt, now, HEARTBEAT_INTERVAL_MS)).toBe(true);
    });

    test("a fresh last-event (just connected) never forces a reconnect", () => {
        const now = 100_000;
        expect(shouldForceReconnectOnResume(now, now, HEARTBEAT_INTERVAL_MS)).toBe(false);
    });
});

describe("shouldStopViewerReconnect", () => {
    test("stops reconnecting after snapshot replay disconnects", () => {
        expect(shouldStopViewerReconnect({ code: "snapshot_replay", reason: "Session is no longer live (snapshot replay)." })).toBe(true);
    });

    test("does not rely on the human-readable reason string", () => {
        expect(shouldStopViewerReconnect({ code: "snapshot_replay", reason: "Replay copy changed" })).toBe(true);
    });

    test("keeps reconnect behavior for other disconnect reasons", () => {
        expect(shouldStopViewerReconnect({ code: "session_reconnected", reason: "Session reconnected" })).toBe(false);
        expect(shouldStopViewerReconnect({ code: "session_ended", reason: "Session ended" })).toBe(false);
        expect(shouldStopViewerReconnect({ reason: "Session is no longer live (snapshot replay)." })).toBe(false);
        expect(shouldStopViewerReconnect({ reason: "" })).toBe(false);
    });
});
