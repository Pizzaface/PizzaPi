import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
    MAX_PENDING_REQUESTS,
    isPendingRequestCapReached,
    pendingSocketMatches,
} from "./runner.js";

// NOTE: These tests deliberately import ONLY the pure helpers and do NOT use
// mock.module. Earlier this file mocked auth/sio-registry/runner-control etc.,
// which — because bun's mock.module is a process-global singleton — clobbered
// those modules for every other test file in the same run (see TODO(ltl2EKmU)),
// breaking runners.broadcast/terminals suites. Testing the extracted predicates
// covers the same security-relevant behaviour with zero cross-file bleed.

describe("runner namespace pending-request hardening", () => {
    test("request IDs are crypto-random UUID v4", () => {
        // sendSkillCommand/sendAgentCommand/sendRunnerCommand all use randomUUID().
        for (let i = 0; i < 5; i++) {
            expect(randomUUID()).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
            );
        }
    });

    test("a response only resolves when it arrives on the SAME socket", () => {
        const pending = { socketId: "socket-a" };
        // Same socket → resolves.
        expect(pendingSocketMatches(pending, "socket-a")).toBe(true);
        // Different socket (guessed/duplicate requestId from another runner conn)
        // → must NOT resolve.
        expect(pendingSocketMatches(pending, "socket-b")).toBe(false);
    });

    test("missing pending entry never matches", () => {
        expect(pendingSocketMatches(undefined, "socket-a")).toBe(false);
    });

    test("pending map rejects new entries once at capacity", () => {
        expect(isPendingRequestCapReached(MAX_PENDING_REQUESTS - 1)).toBe(false);
        expect(isPendingRequestCapReached(MAX_PENDING_REQUESTS)).toBe(true);
        expect(isPendingRequestCapReached(MAX_PENDING_REQUESTS + 1)).toBe(true);
    });
});
