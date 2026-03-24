/**
 * Unit tests for the session_metadata_update server-side handling logic.
 *
 * The relay.ts handler persists metadata fields (model, thinkingLevel, todoList,
 * sessionName) to Redis when a session_metadata_update event arrives. These
 * tests verify the extraction and persistence logic in isolation, without
 * requiring a live Socket.IO connection or Redis instance.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { defaultMetaState, type SessionMetaState } from "../../../../protocol/src/meta.js";

// ── In-memory session store stub (mirrors sio-state + meta.ts logic) ─────────

interface StubSession {
    sessionName: string | null;
    metaState: string | null;
}

const sessionStore = new Map<string, StubSession>();

function stubGetSession(sessionId: string): StubSession | null {
    return sessionStore.get(sessionId) ?? null;
}

async function stubUpdateSessionFields(sessionId: string, fields: Partial<StubSession>): Promise<void> {
    const existing = sessionStore.get(sessionId);
    if (!existing) return;
    sessionStore.set(sessionId, { ...existing, ...fields });
}

async function stubGetMetaState(sessionId: string): Promise<SessionMetaState> {
    const session = stubGetSession(sessionId);
    if (!session?.metaState) return defaultMetaState();
    try {
        return JSON.parse(session.metaState) as SessionMetaState;
    } catch {
        return defaultMetaState();
    }
}

async function stubUpdateMetaState(
    sessionId: string,
    patch: Partial<SessionMetaState>,
): Promise<number> {
    const current = await stubGetMetaState(sessionId);
    const nextVersion = current.version + 1;
    const next: SessionMetaState = { ...current, ...patch, version: nextVersion };
    const existing = sessionStore.get(sessionId) ?? { sessionName: null, metaState: null };
    sessionStore.set(sessionId, { ...existing, metaState: JSON.stringify(next) });
    return nextVersion;
}

/**
 * Inline the server-side session_metadata_update handling logic from relay.ts.
 *
 * This mirrors exactly what the relay handler does after touchSessionActivity:
 * extract model/thinkingLevel/todoList from metadata and persist to metaState,
 * plus update sessionName in the session hash if present.
 */
async function handleMetadataUpdate(
    sessionId: string,
    eventMetadata: Record<string, unknown>,
): Promise<void> {
    const meta = eventMetadata;
    if (!meta || typeof meta !== "object") return;

    const patch: Partial<SessionMetaState> = {};
    if (meta.model && typeof meta.model === "object") patch.model = meta.model as SessionMetaState["model"];
    if (Object.prototype.hasOwnProperty.call(meta, "thinkingLevel")) {
        patch.thinkingLevel = typeof meta.thinkingLevel === "string" ? meta.thinkingLevel : null;
    }
    if (Array.isArray(meta.todoList)) patch.todoList = meta.todoList as SessionMetaState["todoList"];
    if (Object.keys(patch).length > 0) {
        await stubUpdateMetaState(sessionId, patch);
    }

    // sessionName lives in the session hash, not metaState.
    if (Object.prototype.hasOwnProperty.call(meta, "sessionName") &&
        typeof meta.sessionName === "string" && meta.sessionName.trim()) {
        await stubUpdateSessionFields(sessionId, { sessionName: meta.sessionName.trim() });
    }
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
    sessionStore.clear();
    sessionStore.set("s1", { sessionName: null, metaState: null });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("session_metadata_update handler — metadata persistence", () => {
    test("persists model to metaState", async () => {
        const model = { provider: "anthropic", id: "claude-3-5-sonnet", name: "Claude", reasoning: false, contextWindow: 200000 };
        await handleMetadataUpdate("s1", { model });

        const state = await stubGetMetaState("s1");
        expect(state.model).toEqual(model);
    });

    test("persists thinkingLevel to metaState", async () => {
        await handleMetadataUpdate("s1", { thinkingLevel: "high" });

        const state = await stubGetMetaState("s1");
        expect(state.thinkingLevel).toBe("high");
    });

    test("clears thinkingLevel when explicitly null", async () => {
        // Seed a non-null thinkingLevel
        await stubUpdateMetaState("s1", { thinkingLevel: "high" });

        await handleMetadataUpdate("s1", { thinkingLevel: null });

        const state = await stubGetMetaState("s1");
        expect(state.thinkingLevel).toBeNull();
    });

    test("persists todoList to metaState", async () => {
        const todos = [{ id: 1, text: "write tests", status: "pending" as const }];
        await handleMetadataUpdate("s1", { todoList: todos });

        const state = await stubGetMetaState("s1");
        expect(state.todoList).toEqual(todos);
    });

    test("persists sessionName to session hash", async () => {
        await handleMetadataUpdate("s1", { sessionName: "My Session" });

        const session = stubGetSession("s1");
        expect(session?.sessionName).toBe("My Session");
    });

    test("trims whitespace from sessionName before persisting", async () => {
        await handleMetadataUpdate("s1", { sessionName: "  My Session  " });

        const session = stubGetSession("s1");
        expect(session?.sessionName).toBe("My Session");
    });

    test("does not update sessionName when it is an empty string", async () => {
        sessionStore.set("s1", { sessionName: "Previous Name", metaState: null });
        await handleMetadataUpdate("s1", { sessionName: "" });

        const session = stubGetSession("s1");
        expect(session?.sessionName).toBe("Previous Name");
    });

    test("does not update sessionName when it is whitespace-only", async () => {
        sessionStore.set("s1", { sessionName: "Previous Name", metaState: null });
        await handleMetadataUpdate("s1", { sessionName: "   " });

        const session = stubGetSession("s1");
        expect(session?.sessionName).toBe("Previous Name");
    });

    test("does not update sessionName when key is absent", async () => {
        sessionStore.set("s1", { sessionName: "Existing Name", metaState: null });
        await handleMetadataUpdate("s1", { model: { provider: "openai", id: "gpt-4" } });

        const session = stubGetSession("s1");
        expect(session?.sessionName).toBe("Existing Name");
    });

    test("increments metaState version on each call with meta fields", async () => {
        await handleMetadataUpdate("s1", { thinkingLevel: "low" });
        await handleMetadataUpdate("s1", { thinkingLevel: "high" });

        const state = await stubGetMetaState("s1");
        expect(state.version).toBe(2);
    });

    test("does not update metaState when metadata has no recognized meta fields", async () => {
        // metadata with only sessionName (which goes to session hash, not metaState)
        await handleMetadataUpdate("s1", { sessionName: "Name Only" });

        const state = await stubGetMetaState("s1");
        // metaState version stays 0 — no patch was applied
        expect(state.version).toBe(0);
    });

    test("persists multiple fields in one call", async () => {
        const model = { provider: "anthropic", id: "claude-opus", name: "Opus", reasoning: true, contextWindow: 100000 };
        const todos = [{ id: 1, text: "task A", status: "done" as const }];
        await handleMetadataUpdate("s1", {
            model,
            thinkingLevel: "medium",
            todoList: todos,
            sessionName: "Multi Field Session",
        });

        const state = await stubGetMetaState("s1");
        expect(state.model).toEqual(model);
        expect(state.thinkingLevel).toBe("medium");
        expect(state.todoList).toEqual(todos);

        const session = stubGetSession("s1");
        expect(session?.sessionName).toBe("Multi Field Session");
    });

    test("ignores non-object model field", async () => {
        await handleMetadataUpdate("s1", { model: "not-an-object" });

        const state = await stubGetMetaState("s1");
        expect(state.model).toBeNull(); // default — not patched
    });

    test("ignores non-array todoList", async () => {
        await handleMetadataUpdate("s1", { todoList: "not-an-array" });

        const state = await stubGetMetaState("s1");
        expect(state.todoList).toEqual([]); // default — not patched
    });

    test("handles unknown session gracefully (no crash)", async () => {
        // session "unknown" does not exist in the store
        await expect(
            handleMetadataUpdate("unknown", { thinkingLevel: "high" }),
        ).resolves.toBeUndefined();
    });

    test("reconnecting viewer gets current metadata from metaState", async () => {
        // Simulate: runner emits metadata update, then viewer reconnects and reads metaState
        await handleMetadataUpdate("s1", {
            thinkingLevel: "high",
            todoList: [{ id: 1, text: "reconnect test", status: "pending" as const }],
            sessionName: "Reconnect Session",
        });

        // Viewer reads persisted state
        const state = await stubGetMetaState("s1");
        const session = stubGetSession("s1");

        expect(state.thinkingLevel).toBe("high");
        expect(state.todoList).toHaveLength(1);
        expect(state.todoList[0].text).toBe("reconnect test");
        expect(session?.sessionName).toBe("Reconnect Session");
    });
});
