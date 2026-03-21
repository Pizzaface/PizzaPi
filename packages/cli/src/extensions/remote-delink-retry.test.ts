import { describe, expect, it } from "bun:test";
import { evaluateDelinkChildrenAck, evaluateDelinkOwnParentAck } from "./remote-delink-retry.js";
// wasDelinked flag helpers — pure logic, no dependencies
import type { RelayServerToClientEvents } from "@pizzapi/protocol";

describe("remote delink retry helpers", () => {
    describe("evaluateDelinkChildrenAck", () => {
        it("does not clear a newer retry timer when a stale ack arrives", () => {
            const plan = evaluateDelinkChildrenAck({
                ackEpoch: 100,
                pendingEpoch: 200,
                retryEpoch: 200,
                ok: true,
                connected: true,
            });

            expect(plan).toEqual({
                ignoreAck: true,
                clearRetryTimer: false,
                clearPendingDelink: false,
                scheduleRetry: false,
            });
        });

        it("clears only the superseded retry timer when a stale ack matches that timer", () => {
            const plan = evaluateDelinkChildrenAck({
                ackEpoch: 100,
                pendingEpoch: 200,
                retryEpoch: 100,
                ok: true,
                connected: true,
            });

            expect(plan).toEqual({
                ignoreAck: true,
                clearRetryTimer: true,
                clearPendingDelink: false,
                scheduleRetry: false,
            });
        });

        it("schedules a live-socket retry after a nack on the active epoch", () => {
            const plan = evaluateDelinkChildrenAck({
                ackEpoch: 100,
                pendingEpoch: 100,
                retryEpoch: null,
                ok: false,
                connected: true,
            });

            expect(plan).toEqual({
                ignoreAck: false,
                clearRetryTimer: false,
                clearPendingDelink: false,
                scheduleRetry: true,
            });
        });
    });

    describe("wasDelinked flag in registered payload", () => {
        // These tests document the contract that remote.ts relies on:
        // The server includes wasDelinked:true ONLY when an explicit delink
        // marker was found for the child (parent ran /new). Transient parent
        // offline returns parentSessionId:null without wasDelinked.
        it("wasDelinked:true signals explicit delink — client should cancel trigger waits", () => {
            // Build a synthetic registered payload as the server would emit it
            type RegisteredPayload = Parameters<RelayServerToClientEvents["registered"]>[0];
            const explicitDelink: RegisteredPayload = {
                sessionId: "child-1",
                token: "tok",
                shareUrl: "https://example.com",
                isEphemeral: true,
                collabMode: true,
                parentSessionId: null,
                wasDelinked: true,
            };
            expect(explicitDelink.wasDelinked).toBe(true);
            expect(explicitDelink.parentSessionId).toBeNull();
        });

        it("wasDelinked absent signals transient parent offline — client should preserve parent link", () => {
            type RegisteredPayload = Parameters<RelayServerToClientEvents["registered"]>[0];
            const transientOffline: RegisteredPayload = {
                sessionId: "child-1",
                token: "tok",
                shareUrl: "https://example.com",
                isEphemeral: true,
                collabMode: true,
                parentSessionId: null,
                // wasDelinked intentionally omitted — server only sets it for explicit delinks
            };
            expect(transientOffline.wasDelinked).toBeUndefined();
            expect(transientOffline.parentSessionId).toBeNull();
        });
    });

    describe("evaluateDelinkOwnParentAck", () => {
        it("retries delink_own_parent after a nack on a live socket", () => {
            const plan = evaluateDelinkOwnParentAck({
                ok: false,
                pending: true,
                connected: true,
            });

            expect(plan).toEqual({
                confirmed: false,
                scheduleRetry: true,
            });
        });

        it("does not retry delink_own_parent once the pending flag is cleared", () => {
            const plan = evaluateDelinkOwnParentAck({
                ok: false,
                pending: false,
                connected: true,
            });

            expect(plan).toEqual({
                confirmed: false,
                scheduleRetry: false,
            });
        });
    });
});
