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
} = {}): RelayContext & { emitted: unknown[] } {
    const leafId = opts.leafId ?? "leaf-1";
    const messages = opts.messages ?? [];
    const emitted: unknown[] = [];

    // Minimal session manager stub
    const sessionManager = {
        getLeafId: () => leafId,
        getEntries: () => {
            // buildSessionContext returns { messages, model } from entries.
            // We mock at a higher level via the forwardEvent capture below.
            return [];
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
        // Create a fresh context whose leafId has not been recorded
        const ctx = makeContext({ leafId: "unique-fresh-leaf-xyz" });
        // Reset baseline to null by using a leafId that has never been emitted.
        // We can't directly reset the module state, but we can verify the
        // function returns true before any recordEmittedMessageState call.
        //
        // Record a different session state first to ensure the stored baseline
        // won't match, then test with mismatched messages.
        const result = messagesChangedSinceLastEmit(ctx, [{ id: 1 }, { id: 2 }]);
        // Either there's no baseline (true) or the current state differs (true).
        expect(result).toBe(true);
    });

    test("returns false when length and leafId match the last emitted state", () => {
        const ctx = makeContext({ leafId: "leaf-stable" });
        const messages = [{ id: 1 }, { id: 2 }];

        // Record the baseline
        recordEmittedMessageState(ctx, messages);

        // Same length + same leafId → no change
        expect(messagesChangedSinceLastEmit(ctx, messages)).toBe(false);
    });

    test("returns false for a copy of the messages array (length + leafId are same)", () => {
        const ctx = makeContext({ leafId: "leaf-copy" });
        const messages = [{ id: "a" }, { id: "b" }, { id: "c" }];

        recordEmittedMessageState(ctx, messages);

        // Different array reference but same length + leafId
        const copy = [...messages];
        expect(messagesChangedSinceLastEmit(ctx, copy)).toBe(false);
    });

    test("returns true when message count increases", () => {
        const ctx = makeContext({ leafId: "leaf-grow" });
        const original = [{ id: 1 }];
        recordEmittedMessageState(ctx, original);

        const extended = [{ id: 1 }, { id: 2 }];
        expect(messagesChangedSinceLastEmit(ctx, extended)).toBe(true);
    });

    test("returns true when message count decreases", () => {
        const ctx = makeContext({ leafId: "leaf-shrink" });
        const original = [{ id: 1 }, { id: 2 }];
        recordEmittedMessageState(ctx, original);

        const shorter = [{ id: 1 }];
        expect(messagesChangedSinceLastEmit(ctx, shorter)).toBe(true);
    });

    test("returns true when leafId changes even if length is the same", () => {
        const baseCtx = makeContext({ leafId: "leaf-before" });
        const messages = [{ id: 1 }];
        recordEmittedMessageState(baseCtx, messages);

        // Same messages but different leafId (different context)
        const newCtx = makeContext({ leafId: "leaf-after" });
        expect(messagesChangedSinceLastEmit(newCtx, messages)).toBe(true);
    });

    test("returns false for empty messages when baseline is also empty", () => {
        const ctx = makeContext({ leafId: "leaf-empty" });
        recordEmittedMessageState(ctx, []);
        expect(messagesChangedSinceLastEmit(ctx, [])).toBe(false);
    });
});

// ── emitSessionMetadataUpdate ─────────────────────────────────────────────────

describe("emitSessionMetadataUpdate", () => {
    test("emits session_metadata_update when messages have not changed", () => {
        // We need buildSessionContext to return the same messages.
        // emitSessionMetadataUpdate calls buildSessionContext(entries, leafId).
        // With empty entries the result is { messages: [], model: ... }.
        // We record a baseline with empty messages + same leafId.
        const ctx = makeContext({ leafId: "leaf-meta", sessionName: "Test Session", thinkingLevel: "high" });

        // Record a baseline with 0 messages (matching what buildSessionContext returns for empty entries)
        recordEmittedMessageState(ctx, []);

        // Call the function under test
        emitSessionMetadataUpdate(ctx);

        // Should emit a lightweight session_metadata_update (not session_active)
        expect(ctx.emitted.length).toBe(1);
        const evt = ctx.emitted[0] as any;
        expect(evt.type).toBe("session_metadata_update");
        expect(evt.metadata).toBeDefined();
        // cwd must NOT be present (P3 fix)
        expect(Object.prototype.hasOwnProperty.call(evt.metadata, "cwd")).toBe(false);
    });

    test("emits session_active when messages have changed", () => {
        // Record a baseline with 2 messages, but buildSessionContext will return 0
        const ctx = makeContext({ leafId: "leaf-changed" });

        // Record baseline saying 3 messages were last emitted
        // but buildSessionContext (with empty entries) returns 0 — so they differ
        const fakeMessages = [{ id: 1 }, { id: 2 }, { id: 3 }];
        recordEmittedMessageState(ctx, fakeMessages);

        // Call — messages now come from buildSessionContext([], leafId) = [] (length 0 ≠ 3)
        emitSessionMetadataUpdate(ctx);

        // Should fall through to emitSessionActive() which emits session_active
        expect(ctx.emitted.length).toBeGreaterThanOrEqual(1);
        const evt = ctx.emitted[0] as any;
        expect(evt.type).toBe("session_active");
    });

    test("session_metadata_update payload does not include cwd", () => {
        const ctx = makeContext({ leafId: "leaf-nocwd" });
        recordEmittedMessageState(ctx, []);

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
        recordEmittedMessageState(ctx, []);

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

    test("emits nothing when latestCtx is null", () => {
        const ctx = makeContext();
        ctx.latestCtx = null;

        emitSessionMetadataUpdate(ctx);

        expect(ctx.emitted.length).toBe(0);
    });
});
