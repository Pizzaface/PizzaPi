import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTriggerWaitManager } from "../trigger-wait-manager.js";
import { readSessionModelsCache, resetSessionModelsCacheMemo } from "../../session-models-cache.js";

// Unified engine (ADR-0002): lifecycle triggers publish via the trigger-client
// HTTP surface. Mock it so tests assert the publish mapping, not real HTTP.
const publishEventMock = mock(async (params: unknown): Promise<any> => ({
    ok: true,
    eventId: "evt-1",
    deliveries: [{ deliveryId: "dlv-1", sessionId: "parent-1", status: "delivered" }],
}));
mock.module("../trigger-client.js", () => ({
    publishEvent: publishEventMock,
    respondToDelivery: async () => ({ ok: true, relayed: false }),
    fireTrigger: async () => ({ ok: true, method: "http" }),
    broadcastTrigger: async () => ({ ok: true }),
    subscribeTrigger: async () => ({ ok: true }),
    unsubscribeTrigger: async () => ({ ok: true }),
    updateTriggerSubscription: async () => ({ ok: true }),
    listTriggerSubscriptions: async () => [],
    getAvailableTriggers: async () => [],
    getAvailableSigils: async () => [],
}));

const { createRelayContext } = await import("./relay-context-factory.js");

function createSocketMock() {
    const listeners = new Map<string, Array<(data?: any) => void>>();
    const emitted: Array<{ event: string; data: any }> = [];

    return {
        connected: true,
        emitted,
        on(event: string, handler: (data?: any) => void) {
            const handlers = listeners.get(event) ?? [];
            handlers.push(handler);
            listeners.set(event, handlers);
        },
        off(event: string, handler: (data?: any) => void) {
            listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler));
        },
        emit(event: string, data: any, ack?: (result: { ok: boolean; error?: string }) => void) {
            emitted.push({ event, data });
            ack?.({ ok: true });
        },
        fire(event: string, data?: any) {
            for (const handler of listeners.get(event) ?? []) {
                handler(data);
            }
        },
    };
}

describe("getConfiguredModels session snapshot", () => {
    let tempHome: string;
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        tempHome = mkdtempSync(join(tmpdir(), "pizzapi-relay-models-"));
        process.env.HOME = tempHome;
        resetSessionModelsCacheMemo();
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        rmSync(tempHome, { recursive: true, force: true });
    });

    test("writes the live model list (incl. extension-registered providers) to the cache", () => {
        const rctx = createRelayContext({}, createTriggerWaitManager(), { lastBroadcastSessionName: null });
        rctx.latestCtx = {
            modelRegistry: {
                getAvailable: () => [
                    { provider: "claude-subscription", id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true, contextWindow: 200000 },
                ],
                hasConfiguredAuth: () => false,
            },
        } as any;

        const models = rctx.getConfiguredModels();
        expect(models).toHaveLength(1);
        // ponytail: thinkingLevels comes from pi-ai, assert shape not exact levels
        const cached = readSessionModelsCache();
        expect(cached).toMatchObject([
            { provider: "claude-subscription", id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true, contextWindow: 200000 },
        ]);
        expect(Array.isArray(cached?.[0]?.thinkingLevels)).toBe(true);
    });
});

describe("createRelayContext child trigger delivery", () => {
    test("emitTriggerWithAck publishes a lifecycle:ask_question event with fireId correlation", async () => {
        const rctx = createRelayContext({}, createTriggerWaitManager(), { lastBroadcastSessionName: null });
        rctx.relay = { sessionId: "child-1", token: "relay-token", shareUrl: "", seq: 0, ackedSeq: 0 };

        const result = await rctx.emitTriggerWithAck({
            type: "lifecycle:ask_question",
            sourceSessionId: "child-1",
            sourceSessionName: "Child",
            targetSessionId: "parent-1",
            payload: { question: "Continue?", options: ["Yes", "No"] },
            deliverAs: "followUp",
            expectsResponse: true,
            triggerId: "trigger-1",
            timeoutMs: 300_000,
            ts: new Date().toISOString(),
        });

        // The HTTP publish result IS the ack.
        expect(result).toMatchObject({ ok: true });
        expect(publishEventMock).toHaveBeenCalledTimes(1);
        expect(publishEventMock.mock.calls[0][0]).toMatchObject({
            type: "lifecycle:ask_question",
            fireId: "trigger-1",
            target: { sessionId: "parent-1", deliverAs: "followUp" },
            source: { kind: "session", id: "child-1", name: "Child" },
            responseContract: { escalate: true, ttlMs: 30 * 60 * 1000 },
            payload: { question: "Continue?", options: ["Yes", "No"] },
        });
    });

    test("emitTriggerWithAck surfaces publish failures", async () => {
        const rctx = createRelayContext({}, createTriggerWaitManager(), { lastBroadcastSessionName: null });
        rctx.relay = { sessionId: "child-1", token: "relay-token", shareUrl: "", seq: 0, ackedSeq: 0 };
        publishEventMock.mockImplementationOnce(async () => ({ ok: false, error: "relay unreachable" }));

        const result = await rctx.emitTriggerWithAck({
            type: "lifecycle:plan_review",
            sourceSessionId: "child-1",
            sourceSessionName: "Child",
            targetSessionId: "parent-1",
            payload: {},
            deliverAs: "steer",
            expectsResponse: true,
            triggerId: "trigger-2",
            ts: new Date().toISOString(),
        });

        expect(result).toEqual({ ok: false, error: "relay unreachable" });
    });

    test("emitTriggerWithAck fails fast with no relay configured", async () => {
        publishEventMock.mockClear();
        const rctx = createRelayContext({}, createTriggerWaitManager(), { lastBroadcastSessionName: null });
        rctx.relay = null;

        const result = await rctx.emitTriggerWithAck({
            type: "lifecycle:plan_review",
            sourceSessionId: "child-1",
            targetSessionId: "parent-1",
            payload: {},
            deliverAs: "steer",
            expectsResponse: true,
            triggerId: "trigger-3",
            ts: new Date().toISOString(),
        });

        expect(result).toEqual({ ok: false, error: "Not connected to relay" });
        expect(publishEventMock).not.toHaveBeenCalled();
    });

    test("waitForTriggerResponse ignores unrelated session_message_error events", async () => {
        const rctx = createRelayContext({}, createTriggerWaitManager(), { lastBroadcastSessionName: null });
        const socket = createSocketMock();
        rctx.relay = { sessionId: "child-1", token: "relay-token", shareUrl: "", seq: 0, ackedSeq: 0 };
        rctx.sioSocket = socket as any;
        rctx.parentSessionId = "parent-1";

        const responsePromise = rctx.waitForTriggerResponse("trigger-1", 100);
        socket.fire("session_message_error", {
            targetSessionId: "parent-1",
            triggerId: "different-trigger",
            error: "Unrelated delivery failure",
        });
        socket.fire("trigger_response", {
            triggerId: "trigger-1",
            response: "Approved",
            action: "approve",
        });

        await expect(responsePromise).resolves.toEqual({
            response: "Approved",
            action: "approve",
            cancelled: false,
        });
    });

    test("waitForTriggerResponse with no timeoutMs never auto-cancels — only settles on a real response", async () => {
        const rctx = createRelayContext({}, createTriggerWaitManager(), { lastBroadcastSessionName: null });
        const socket = createSocketMock();
        rctx.relay = { sessionId: "child-1", token: "relay-token", shareUrl: "", seq: 0, ackedSeq: 0 };
        rctx.sioSocket = socket as any;
        rctx.parentSessionId = "parent-1";

        const responsePromise = rctx.waitForTriggerResponse("trigger-1");

        // Still unsettled well past what used to be an arbitrary bounded wait —
        // with no timeoutMs, nothing should auto-cancel it.
        const raceResult = await Promise.race([
            responsePromise.then(() => "settled" as const),
            new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
        ]);
        expect(raceResult).toBe("pending");

        socket.fire("trigger_response", { triggerId: "trigger-1", response: "Approved", action: "approve" });

        await expect(responsePromise).resolves.toEqual({
            response: "Approved",
            action: "approve",
            cancelled: false,
        });
    });
});
