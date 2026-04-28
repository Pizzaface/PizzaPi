import { describe, expect, test } from "bun:test";
import { emitSessionCompleteWithAck } from "./session-complete-delivery.js";

describe("emitSessionCompleteWithAck", () => {
    test("emits session_complete and resolves when the relay acks delivery", async () => {
        const calls: Array<{ event: string; data: any }> = [];
        const socket = {
            on() {},
            off() {},
            emit(event: string, data: any, ack?: (result: { ok: boolean; error?: string }) => void) {
                calls.push({ event, data });
                ack?.({ ok: true });
            },
        };

        const result = await emitSessionCompleteWithAck({
            socket: socket as any,
            token: "relay-token",
            sourceSessionId: "child-1",
            targetSessionId: "parent-1",
            triggerId: "trigger-1",
            summary: "Done",
            exitReason: "completed",
        });

        expect(result).toEqual({ ok: true });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.event).toBe("session_trigger");
        expect(calls[0]?.data).toMatchObject({
            token: "relay-token",
            trigger: {
                type: "session_complete",
                sourceSessionId: "child-1",
                targetSessionId: "parent-1",
                triggerId: "trigger-1",
                deliverAs: "followUp",
                expectsResponse: true,
                payload: {
                    summary: "Done",
                    exitCode: 0,
                    exitReason: "completed",
                },
            },
        });
        expect(typeof calls[0]?.data?.trigger?.ts).toBe("string");
    });

    test("surfaces relay rejection instead of silently succeeding", async () => {
        const socket = {
            on() {},
            off() {},
            emit(_event: string, _data: any, ack?: (result: { ok: boolean; error?: string }) => void) {
                ack?.({ ok: false, error: "Target session parent-1 is not connected" });
            },
        };

        const result = await emitSessionCompleteWithAck({
            socket: socket as any,
            token: "relay-token",
            sourceSessionId: "child-1",
            targetSessionId: "parent-1",
            triggerId: "trigger-1",
            summary: "Done",
            exitReason: "completed",
        });

        expect(result).toEqual({ ok: false, error: "Target session parent-1 is not connected" });
    });

    test("treats missing ack as success for legacy relay servers when no error arrives", async () => {
        const socket = {
            on() {},
            off() {},
            emit(_event: string, _data: any, _ack?: (result: { ok: boolean; error?: string }) => void) {
                // Legacy server: trigger is delivered but no ack callback is ever invoked.
            },
        };

        const result = await emitSessionCompleteWithAck({
            socket: socket as any,
            token: "relay-token",
            sourceSessionId: "child-1",
            targetSessionId: "parent-1",
            triggerId: "trigger-1",
            summary: "Done",
            exitReason: "completed",
            timeoutMs: 5,
            assumeSuccessOnAckTimeout: true,
        });

        expect(result).toEqual({ ok: true });
    });

    test("fails fast when the relay reports a delivery error for the same trigger", async () => {
        const listeners = new Map<string, Array<(data: any) => void>>();
        const socket = {
            on(event: string, handler: (data: any) => void) {
                const handlers = listeners.get(event) ?? [];
                handlers.push(handler);
                listeners.set(event, handlers);
            },
            off(event: string, handler: (data: any) => void) {
                listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler));
            },
            emit(_event: string, data: any, _ack?: (result: { ok: boolean; error?: string }) => void) {
                for (const handler of listeners.get("session_message_error") ?? []) {
                    handler({
                        targetSessionId: data.trigger.targetSessionId,
                        triggerId: data.trigger.triggerId,
                        error: "Sender is no longer a child of the target session",
                    });
                }
            },
        };

        const result = await emitSessionCompleteWithAck({
            socket: socket as any,
            token: "relay-token",
            sourceSessionId: "child-1",
            targetSessionId: "parent-1",
            triggerId: "trigger-1",
            summary: "Done",
            exitReason: "completed",
            timeoutMs: 50,
        });

        expect(result).toEqual({ ok: false, error: "Sender is no longer a child of the target session" });
    });

    test("ignores unrelated session_message_error events for the same parent session", async () => {
        const listeners = new Map<string, Array<(data: any) => void>>();
        const socket = {
            connected: true,
            on(event: string, handler: (data: any) => void) {
                const handlers = listeners.get(event) ?? [];
                handlers.push(handler);
                listeners.set(event, handlers);
            },
            off(event: string, handler: (data: any) => void) {
                listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler));
            },
            emit(_event: string, data: any, _ack?: (result: { ok: boolean; error?: string }) => void) {
                for (const handler of listeners.get("session_message_error") ?? []) {
                    handler({
                        targetSessionId: data.trigger.targetSessionId,
                        triggerId: "different-trigger",
                        error: "Unrelated trigger failed",
                    });
                }
            },
        };

        const result = await emitSessionCompleteWithAck({
            socket: socket as any,
            token: "relay-token",
            sourceSessionId: "child-1",
            targetSessionId: "parent-1",
            triggerId: "trigger-1",
            summary: "Done",
            exitReason: "completed",
            timeoutMs: 5,
            assumeSuccessOnAckTimeout: true,
        });

        expect(result).toEqual({ ok: true });
    });

    test("fails instead of assuming success when the socket disconnects before any ack arrives", async () => {
        const listeners = new Map<string, Array<(data?: any) => void>>();
        const socket = {
            connected: true,
            on(event: string, handler: (data?: any) => void) {
                const handlers = listeners.get(event) ?? [];
                handlers.push(handler);
                listeners.set(event, handlers);
            },
            off(event: string, handler: (data?: any) => void) {
                listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler));
            },
            emit(_event: string, _data: any, _ack?: (result: { ok: boolean; error?: string }) => void) {
                socket.connected = false;
                for (const handler of listeners.get("disconnect") ?? []) {
                    handler();
                }
            },
        };

        const result = await emitSessionCompleteWithAck({
            socket: socket as any,
            token: "relay-token",
            sourceSessionId: "child-1",
            targetSessionId: "parent-1",
            triggerId: "trigger-1",
            summary: "Done",
            exitReason: "completed",
            timeoutMs: 5,
        });

        expect(result).toEqual({ ok: false, error: "Socket disconnected before relay ack" });
    });

    test("treats legacy delivery errors without triggerId as failures", async () => {
        const listeners = new Map<string, Array<(data: any) => void>>();
        const socket = {
            on(event: string, handler: (data: any) => void) {
                const handlers = listeners.get(event) ?? [];
                handlers.push(handler);
                listeners.set(event, handlers);
            },
            off(event: string, handler: (data: any) => void) {
                listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler));
            },
            emit(_event: string, data: any, _ack?: (result: { ok: boolean; error?: string }) => void) {
                for (const handler of listeners.get("session_message_error") ?? []) {
                    handler({
                        targetSessionId: data.trigger.targetSessionId,
                        error: "Legacy relay reported delivery failure",
                    });
                }
            },
        };

        const result = await emitSessionCompleteWithAck({
            socket: socket as any,
            token: "relay-token",
            sourceSessionId: "child-1",
            targetSessionId: "parent-1",
            triggerId: "trigger-1",
            summary: "Done",
            exitReason: "completed",
            timeoutMs: 5,
            assumeSuccessOnAckTimeout: true,
        });

        expect(result).toEqual({ ok: false, error: "Legacy relay reported delivery failure" });
    });
});
