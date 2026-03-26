import { describe, expect, test } from "bun:test";
import { shouldStopViewerReconnect } from "./viewer-connection.js";

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
