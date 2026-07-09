/**
 * Unit tests for chunked-delivery.ts
 *
 * Tests cover:
 * - messagesChangedSinceLastEmit: baseline detection logic
 * - emitSessionMetadataUpdate: dispatches correct event type based on message change state
 */

import { afterEach, describe, test, expect, beforeEach } from "bun:test";
import {
    messagesChangedSinceLastEmit,
    recordEmittedMessageState,
    emitSessionMetadataUpdate,
    emitSessionActive,
    buildLiveSessionAnalysis,
    readQueuedFollowUps,
} from "./chunked-delivery.js";
import type { RelayContext } from "../remote-types.js";
import { resetSessionAnalysis, sessionAnalysisExtension } from "../session-analysis.js";

const originalSessionId = process.env.PIZZAPI_SESSION_ID;

afterEach(() => {
    if (originalSessionId == null) delete process.env.PIZZAPI_SESSION_ID;
    else process.env.PIZZAPI_SESSION_ID = originalSessionId;
    resetSessionAnalysis("test-session");
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal RelayContext mock for testing. */
function makeContext(opts: {
    leafId?: string | null;
    messages?: unknown[];
    sessionName?: string | null;
    thinkingLevel?: string | null;
    currentModel?: {
        provider: string;
        id: string;
        name?: string;
        reasoning?: boolean;
        contextWindow?: number;
    } | null;
    transcriptModel?: {
        provider: string;
        modelId: string;
    } | null;
    entries?: unknown[];
} = {}): RelayContext & { emitted: unknown[] } {
    const leafId = opts.leafId ?? "leaf-1";
    const messages = opts.messages ?? [];
    const emitted: unknown[] = [];

    // Minimal session manager stub
    const sessionManager = {
        getLeafId: () => leafId,
        getEntries: () => {
            if (opts.entries) return opts.entries;
            if (!opts.transcriptModel || !leafId) return [];
            return [{
                id: leafId,
                parentId: null,
                timestamp: new Date(0).toISOString(),
                type: "model_change",
                provider: opts.transcriptModel.provider,
                modelId: opts.transcriptModel.modelId,
            }];
        },
    };

    return {
        // Core
        pi: null,
        relay: null,
        sioSocket: null,
        latestCtx: {
            cwd: "/tmp",
            sessionManager,
            model: opts.currentModel ?? null,
        } as any,

        // Flags
        isAgentActive: false,
        isCompacting: false,
        shuttingDown: false,
        wasAborted: false,
        sessionStartedAt: null,
        lastRetryableError: null,

        // Identity
        parentSessionId: null,
        isChildSession: false,
        relaySessionId: "test-session",

        // Pending interactions
        pendingAskUserQuestion: null,
        pendingPlanMode: null,
        pendingPluginTrust: null,

        // Cache
        lastMcpStartupReport: null,

        // Helpers
        forwardEvent: (event: unknown) => emitted.push(event),
        sendToWeb: () => {},
        relayUrl: () => "ws://localhost",
        relayHttpBaseUrl: () => "http://localhost",
        apiKey: () => undefined,
        setRelayStatus: () => {},
        disconnectedStatusText: () => undefined,
        isConnected: () => true,

        // State builders
        buildSessionState: () => ({}),
        emitSessionActive: () => {},
        buildHeartbeat: () => ({}),
        buildCapabilitiesState: () => ({}),
        getConfiguredModels: () => [],
        getAvailableCommands: () => [],
        getCurrentSessionName: () => opts.sessionName ?? null,
        getCurrentThinkingLevel: () => opts.thinkingLevel ?? null,

        // Relay status
        relayStatusText: "",

        // Triggers
        emitTrigger: () => {},
        emitTriggerWithAck: async () => ({ ok: true }),
        waitForTriggerResponse: async () => ({ response: "" }),

        // Session name sync
        markSessionNameBroadcasted: () => {},

        // Test capture
        emitted,
    } as any;
}

function createFakePi() {
    const handlers = new Map<string, Array<(event?: unknown) => void>>();
    return {
        api: {
            on(event: string, handler: (event?: unknown) => void) {
                const list = handlers.get(event) ?? [];
                list.push(handler);
                handlers.set(event, list);
            },
        },
        emit(event: string, payload?: unknown) {
            for (const handler of handlers.get(event) ?? []) handler(payload);
        },
    };
}

// ── messagesChangedSinceLastEmit ─────────────────────────────────────────────

describe("messagesChangedSinceLastEmit", () => {
    beforeEach(() => {
        // Reset module-level state by recording a fresh baseline with no messages.
        // We use a dummy context with no leafId and empty messages so that
        // subsequent tests start from a known state.
    });

    test("returns true when no baseline has been recorded yet", () => {
        const ctx = makeContext({ leafId: "unique-fresh-leaf-xyz" });
        const result = messagesChangedSinceLastEmit(ctx);
        expect(result).toBe(true);
    });

    test("returns false when leafId matches the last emitted state", () => {
        const ctx = makeContext({ leafId: "leaf-stable" });

        // Record the baseline
        recordEmittedMessageState(ctx);

        // Same leafId → no change
        expect(messagesChangedSinceLastEmit(ctx)).toBe(false);
    });

    test("returns true when leafId changes", () => {
        const baseCtx = makeContext({ leafId: "leaf-before" });
        recordEmittedMessageState(baseCtx);

        // Different leafId
        const newCtx = makeContext({ leafId: "leaf-after" });
        expect(messagesChangedSinceLastEmit(newCtx)).toBe(true);
    });

    test("returns false for same leafId after multiple calls", () => {
        const ctx = makeContext({ leafId: "leaf-repeat" });
        recordEmittedMessageState(ctx);

        expect(messagesChangedSinceLastEmit(ctx)).toBe(false);
        expect(messagesChangedSinceLastEmit(ctx)).toBe(false);
        expect(messagesChangedSinceLastEmit(ctx)).toBe(false);
    });
});

// ── emitSessionMetadataUpdate ─────────────────────────────────────────────────

describe("readQueuedFollowUps", () => {
    test("returns [] when pi is unavailable", () => {
        const ctx = makeContext();
        expect(readQueuedFollowUps(ctx)).toEqual([]);
    });

    test("returns a copy of pi's follow-up queue", () => {
        const ctx = makeContext();
        const followUp = ["first", "second"];
        (ctx as any).pi = { getQueuedMessages: () => ({ steering: ["s"], followUp }) };
        const result = readQueuedFollowUps(ctx);
        expect(result).toEqual(["first", "second"]);
        expect(result).not.toBe(followUp);
    });

    test("returns [] when getQueuedMessages throws (stale extension ctx)", () => {
        const ctx = makeContext();
        (ctx as any).pi = { getQueuedMessages: () => { throw new Error("stale"); } };
        expect(readQueuedFollowUps(ctx)).toEqual([]);
    });

    test("session_metadata_update and session_active include queuedMessages", () => {
        const ctx = makeContext({ leafId: "leaf-queue" });
        (ctx as any).pi = { getQueuedMessages: () => ({ steering: [], followUp: ["queued follow-up"] }) };

        recordEmittedMessageState(ctx);
        emitSessionMetadataUpdate(ctx);
        const meta = ctx.emitted[0] as any;
        expect(meta.type).toBe("session_metadata_update");
        expect(meta.metadata.queuedMessages).toEqual(["queued follow-up"]);

        const activeCtx = makeContext({ leafId: "leaf-queue-2" });
        (activeCtx as any).pi = { getQueuedMessages: () => ({ steering: [], followUp: ["queued follow-up"] }) };
        emitSessionActive(activeCtx);
        const active = activeCtx.emitted[0] as any;
        expect(active.type).toBe("session_active");
        expect(active.state.queuedMessages).toEqual(["queued follow-up"]);
    });
});

describe("emitSessionMetadataUpdate", () => {
    test("emits session_metadata_update when leafId has not changed", () => {
        const ctx = makeContext({ leafId: "leaf-meta", sessionName: "Test Session", thinkingLevel: "high" });

        // Record a baseline with same leafId
        recordEmittedMessageState(ctx);

        // Call the function under test
        emitSessionMetadataUpdate(ctx);

        // Should emit a lightweight session_metadata_update (not session_active)
        expect(ctx.emitted.length).toBe(1);
        const evt = ctx.emitted[0] as any;
        expect(evt.type).toBe("session_metadata_update");
        expect(evt.metadata).toBeDefined();
        // cwd must NOT be present
        expect(Object.prototype.hasOwnProperty.call(evt.metadata, "cwd")).toBe(false);
    });

    test("emits session_active when leafId has changed", () => {
        // Record baseline with leafId "leaf-before"
        const beforeCtx = makeContext({ leafId: "leaf-before" });
        recordEmittedMessageState(beforeCtx);

        // Now test with a different leafId
        const ctx = makeContext({ leafId: "leaf-changed" });

        // LeafId differs from baseline → should emit session_active
        emitSessionMetadataUpdate(ctx);

        // Should fall through to emitSessionActive() which emits session_active
        expect(ctx.emitted.length).toBeGreaterThanOrEqual(1);
        const evt = ctx.emitted[0] as any;
        expect(evt.type).toBe("session_active");
    });

    test("session_metadata_update payload does not include cwd", () => {
        const ctx = makeContext({ leafId: "leaf-nocwd" });
        recordEmittedMessageState(ctx);

        emitSessionMetadataUpdate(ctx);

        const evt = ctx.emitted[0] as any;
        expect(evt.type).toBe("session_metadata_update");
        expect(evt.metadata).toBeDefined();
        expect(Object.prototype.hasOwnProperty.call(evt.metadata, "cwd")).toBe(false);
    });

    test("reconstructs analysis from transcript entries when live accumulator is empty", () => {
        const ctx = makeContext({
            leafId: "assistant-1",
            entries: [
                { type: "session", id: "test-session", timestamp: new Date(0).toISOString(), cwd: "/tmp" },
                {
                    type: "message",
                    id: "assistant-1",
                    parentId: null,
                    timestamp: new Date(0).toISOString(),
                    message: {
                        role: "assistant",
                        provider: "anthropic",
                        model: "claude-sonnet-4-5",
                        usage: {
                            input: 1200,
                            output: 100,
                            cacheRead: 300,
                            cacheWrite: 0,
                            totalTokens: 1600,
                            cost: { total: 0.01 },
                        },
                    },
                },
            ],
        });

        const analysis = buildLiveSessionAnalysis(ctx);

        expect(analysis?.blocks).toHaveLength(1);
        expect(analysis?.blocks[0]).toMatchObject({
            entryId: "assistant-1",
            role: "turn",
            tokens: 1200,
        });
    });

    test("prefers transcript reconstruction over live accumulator for rich context roles", () => {
        process.env.PIZZAPI_SESSION_ID = "test-session";
        const fakePi = createFakePi();
        sessionAnalysisExtension(fakePi.api as any);
        fakePi.emit("session_start");
        fakePi.emit("turn_end", {
            turnIndex: 0,
            entryId: "assistant-1",
            message: {
                role: "assistant",
                provider: "anthropic",
                model: "claude-sonnet-4-5",
                usage: {
                    input: 1200,
                    output: 100,
                    cacheRead: 300,
                    cacheWrite: 0,
                    totalTokens: 1600,
                    cost: { total: 0.01 },
                },
            },
        });

        const ctx = makeContext({
            leafId: "assistant-1",
            entries: [
                { type: "session", id: "test-session", timestamp: new Date(0).toISOString(), cwd: "/tmp" },
                {
                    type: "custom_message",
                    id: "context-1",
                    parentId: null,
                    timestamp: new Date(0).toISOString(),
                    customType: "context:global-rules",
                    content: "Global rules ".repeat(200),
                },
                {
                    type: "message",
                    id: "assistant-1",
                    parentId: "context-1",
                    timestamp: new Date(0).toISOString(),
                    message: {
                        role: "assistant",
                        provider: "anthropic",
                        model: "claude-sonnet-4-5",
                        usage: {
                            input: 1200,
                            output: 100,
                            cacheRead: 300,
                            cacheWrite: 0,
                            totalTokens: 1600,
                            cost: { total: 0.01 },
                        },
                    },
                },
            ],
        });

        const analysis = buildLiveSessionAnalysis(ctx);
        const roles = analysis?.blocks.map((block) => block.role) ?? [];

        expect(roles).toContain("turn");
        expect(roles).toContain("context:global-rules");
    });

    test("session_metadata_update includes model, sessionName, thinkingLevel, todoList, availableModels", () => {
        const ctx = makeContext({
            leafId: "leaf-fields",
            sessionName: "My Session",
            thinkingLevel: "medium",
            currentModel: {
                provider: "anthropic",
                id: "claude-sonnet-4-5",
                name: "Claude Sonnet 4.5",
                contextWindow: 200000,
            },
        });
        recordEmittedMessageState(ctx);

        emitSessionMetadataUpdate(ctx);

        const evt = ctx.emitted[0] as any;
        expect(evt.type).toBe("session_metadata_update");
        expect(evt.metadata.model).toEqual({
            provider: "anthropic",
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            reasoning: undefined,
            contextWindow: 200000,
        });
        const keys = Object.keys(evt.metadata);
        expect(keys).toContain("model");
        expect(keys).toContain("sessionName");
        expect(keys).toContain("thinkingLevel");
        expect(keys).toContain("todoList");
        expect(keys).toContain("availableModels");
        expect(keys).toContain("availableCommands");
        expect(keys).toContain("analysis");
    });

    test("session_metadata_update falls back to transcript model when no live model exists", () => {
        const ctx = makeContext({
            leafId: "leaf-transcript-fallback",
            transcriptModel: {
                provider: "anthropic",
                modelId: "claude-opus-4",
            },
        });
        recordEmittedMessageState(ctx);

        emitSessionMetadataUpdate(ctx);

        const evt = ctx.emitted[0] as any;
        expect(evt.type).toBe("session_metadata_update");
        expect(evt.metadata.model).toEqual({
            provider: "anthropic",
            id: "claude-opus-4",
            contextWindow: undefined,
        });
    });

    test("session_active prefers the live current model over transcript-derived state", () => {
        const ctx = makeContext({
            leafId: "leaf-live-model",
            currentModel: {
                provider: "google",
                id: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                contextWindow: 1000000,
            },
        });

        emitSessionActive(ctx);

        const evt = ctx.emitted[0] as any;
        expect(evt.type).toBe("session_active");
        expect(evt.state.model).toEqual({
            provider: "google",
            id: "gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
            reasoning: undefined,
            contextWindow: 1000000,
        });
    });

    test("session_active falls back to transcript model when no live model exists", () => {
        const ctx = makeContext({
            leafId: "leaf-active-transcript-fallback",
            transcriptModel: {
                provider: "openai",
                modelId: "gpt-4.1",
            },
        });

        emitSessionActive(ctx);

        const evt = ctx.emitted[0] as any;
        expect(evt.type).toBe("session_active");
        expect(evt.state.model).toEqual({
            provider: "openai",
            id: "gpt-4.1",
            contextWindow: undefined,
        });
    });

    test("emits nothing when latestCtx is null", () => {
        const ctx = makeContext();
        ctx.latestCtx = null;

        emitSessionMetadataUpdate(ctx);

        expect(ctx.emitted.length).toBe(0);
    });
});
