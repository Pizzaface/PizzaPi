/**
 * Unit tests for chunked-delivery.ts
 *
 * Tests cover:
 * - messagesChangedSinceLastEmit: baseline detection logic
 * - emitSessionMetadataUpdate: dispatches correct event type based on message change state
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
    messagesChangedSinceLastEmit,
    recordEmittedMessageState,
    emitSessionMetadataUpdate,
    emitSessionActive,
} from "./chunked-delivery.js";
import type { RelayContext } from "../remote-types.js";

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
} = {}): RelayContext & { emitted: unknown[] } {
    const leafId = opts.leafId ?? "leaf-1";
    const messages = opts.messages ?? [];
    const emitted: unknown[] = [];

    // Minimal session manager stub
    const sessionManager = {
        getLeafId: () => leafId,
        getEntries: () => {
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
