// ============================================================================
// context.emit-relay-session-fallback.test.ts
//
// Regression: same race class as the disconnect-handler zombie-socket bug.
// emitToRelaySession() falls back to local-only delivery when the Redis
// adapter emit throws, but ONLY if the session's local socket is actually
// connected. A present-but-disconnected `localTuiSockets` entry (left behind
// by, e.g., an early-returning disconnect handler) must not make this
// function claim success — the local room would be empty, and callers like
// MCP OAuth would wrongly consume a nonce for a delivery that never happened.
// ============================================================================

import { describe, expect, it } from "bun:test";
import { initSioRegistry, localTuiSockets, emitToRelaySession } from "./context.js";

function fakeIoWithThrowingRelayEmit() {
    return {
        of: (name: string) => {
            if (name === "/relay") {
                return {
                    to: () => ({
                        emit: () => {
                            throw new Error("EPIPE (test)");
                        },
                    }),
                    local: {
                        to: () => ({ emit: () => {} }),
                    },
                };
            }
            return { to: () => ({ emit: () => {} }) };
        },
    };
}

describe("emitToRelaySession — local fallback only for a live local socket", () => {
    it("returns false when the local socket entry is present but disconnected", () => {
        localTuiSockets.clear();
        initSioRegistry(fakeIoWithThrowingRelayEmit() as never);
        localTuiSockets.set("sess-zombie", { connected: false } as never);

        const result = emitToRelaySession("sess-zombie", "test_event", {});

        expect(result).toBe(false);
    });

    it("returns true when the local socket entry is present and connected", () => {
        localTuiSockets.clear();
        initSioRegistry(fakeIoWithThrowingRelayEmit() as never);
        localTuiSockets.set("sess-live", { connected: true } as never);

        const result = emitToRelaySession("sess-live", "test_event", {});

        expect(result).toBe(true);
    });

    it("returns false when there is no local socket entry at all", () => {
        localTuiSockets.clear();
        initSioRegistry(fakeIoWithThrowingRelayEmit() as never);

        const result = emitToRelaySession("sess-none", "test_event", {});

        expect(result).toBe(false);
    });
});
