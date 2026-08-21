// ============================================================================
// sessions.snapshot-overlay-durability.test.ts — Health inspection A2
//
// Proves that the snapshot overlay is stored only in Redis and is never
// persisted to SQLite between full session_active snapshots. After a relay
// restart / Redis loss, a reconnecting viewer that falls back to the durable
// SQLite snapshot receives stale metadata (missing queuedMessages, model
// patches, sessionName updates, etc.) because the overlay vanished.
//
// This is distinct from the snapshot-write throttle (which only controls how
// often the *base* state is written) and from anonymous adoption (which is an
// ownership/userId divergence).
// ============================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";

// ── In-memory SQLite (no temp files, no singleton) ─────────────────────────
const memDb = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

mock.module("../../auth.js", () => ({
    getKysely: () => memDb,
    createTestDatabase: () => memDb,
    _setKyselyForTest: () => {},
}));

// Disable Redis so the lazy relay-event-cache module never tries to connect.
process.env.PIZZAPI_REDIS_URL = "off";

// ── In-memory sio-state Redis shim ─────────────────────────────────────────
const sessionStore = new Map<string, Record<string, unknown>>();
const sioKey = (sessionId: string) => `sio:${sessionId}`;

mock.module("../sio-state/index.js", () => ({
    initStateRedis: async () => {},
    setSession: async (sessionId: string, data: Record<string, unknown>) => {
        sessionStore.set(sioKey(sessionId), { ...data });
    },
    getSession: async (sessionId: string) => sessionStore.get(sioKey(sessionId)) ?? null,
    getSessionSummary: async (sessionId: string) => {
        const s = sessionStore.get(sioKey(sessionId));
        return s ? ({ ...s } as Record<string, unknown>) : null;
    },
    getSessionField: async (sessionId: string, field: string) => {
        const s = sessionStore.get(sioKey(sessionId));
        return s?.[field] ?? null;
    },
    updateSessionFields: async (sessionId: string, fields: Record<string, unknown>) => {
        const s = sessionStore.get(sioKey(sessionId));
        if (!s) return;
        Object.assign(s, fields);
    },
    upsertSessionFields: async (sessionId: string, fields: Record<string, unknown>) => {
        const s = sessionStore.get(sioKey(sessionId)) ?? {};
        sessionStore.set(sioKey(sessionId), s);
        Object.assign(s, fields);
    },
    deleteSession: async (sessionId: string) => {
        sessionStore.delete(sioKey(sessionId));
    },
    getAllSessionSummaries: async () => [],
    getAllSessions: async () => [],
    refreshSessionTTL: async () => {},
    incrementSeq: async () => 1,
    getSeq: async () => 0,
    setPendingRunnerLink: async () => {},
    getPendingRunnerLink: async () => null,
    deletePendingRunnerLink: async () => {},
    getRunnerAssociation: async () => null,
    setRunnerAssociation: async () => {},
    refreshRunnerAssociationTTL: async () => {},
    scanExpiredSessions: async () => [],
    cleanStaleIndexEntries: async () => {},
    addChildSession: async () => {},
    addChildSessionMembership: async () => {},
    removeChildSession: async () => {},
    getChildSessions: async () => [],
    isChildOfParent: async () => false,
    isLinkedChildForSuppression: async () => false,
    addPendingParentDelinkChildren: async () => {},
    getPendingParentDelinkChildren: async () => [],
    isPendingParentDelinkChild: async () => false,
    removePendingParentDelinkChild: async () => {},
    markChildAsDelinked: async () => {},
    isChildDelinked: async () => false,
    clearDelinkedMark: async () => {},
    clearParentSessionId: async () => {},
    refreshChildSessionsTTL: async () => {},
    setRunner: async () => {},
    getRunner: async () => null,
    updateRunnerFields: async () => {},
    deleteRunner: async () => {},
    getAllRunners: async () => [],
    refreshRunnerTTL: async () => {},
    deleteRunnerAssociation: async () => {},
    setTerminal: async () => {},
    getTerminal: async () => null,
    claimTerminalSpawn: async () => null,
    updateTerminalFields: async () => {},
    deleteTerminal: async () => {},
    getTerminalsForRunner: async () => [],
    setPushPendingQuestion: async () => {},
    getPushPendingQuestion: async () => null,
    consumePushPendingQuestionIfMatches: async () => false,
    clearPushPendingQuestion: async () => {},
}));

// Mock best-effort trigger paths so sessions.ts can load without side effects.
mock.module("../../sessions/trigger-subscription-store.js", () => ({
    clearSessionSubscriptions: async () => {},
}));
mock.module("../../sessions/trigger-store.js", () => ({
    pushTriggerHistory: async () => {},
    recordTriggerResponse: async () => {},
}));

afterAll(() => mock.restore());

// ── Import real SQLite store and the module under inspection ───────────────
const {
    ensureRelaySessionTables,
    recordRelaySessionStart,
    recordRelaySessionState,
    getPersistedRelaySessionSnapshot,
} = await import("../../sessions/store.js");

const { patchSessionSnapshotState } = await import("./sessions.js");

const USER_ID = "user-overlay";
const SESSION_ID = "sess-overlay-loss";

beforeAll(async () => {
    await ensureRelaySessionTables();
});

beforeEach(async () => {
    sessionStore.clear();
    await memDb.deleteFrom("relay_session_state").execute();
    await memDb.deleteFrom("relay_session").execute();
});

describe("snapshot overlay durability", () => {
    it("loses queued metadata when Redis is gone before the next full snapshot", async () => {
        // 1. Persist a durable base session and state to SQLite.
        await recordRelaySessionStart({
            sessionId: SESSION_ID,
            userId: USER_ID,
            cwd: "/project",
            shareUrl: `http://test/${SESSION_ID}`,
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        const baseState = {
            messages: [{ role: "user", content: "hello" }],
            model: { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
            sessionName: "Base",
            queuedMessages: [],
        };
        await recordRelaySessionState(SESSION_ID, USER_ID, baseState);

        // 2. Runner sends only metadata updates; the relay accumulates them
        //    in the Redis-only snapshotOverlay instead of rewriting the multi-MB
        //    lastState blob.
        sessionStore.set(sioKey(SESSION_ID), {
            sessionId: SESSION_ID,
            userId: USER_ID,
            isEphemeral: false,
            lastState: JSON.stringify(baseState),
            snapshotOverlay: null,
        });

        await patchSessionSnapshotState(SESSION_ID, {
            queuedMessages: ["follow-up one", "follow-up two"],
            model: { provider: "anthropic", id: "claude-sonnet-4-5", thinking: true },
            sessionName: "Renamed",
        });

        const liveOverlay = sessionStore.get(sioKey(SESSION_ID))?.snapshotOverlay as string | undefined;
        expect(liveOverlay).toBeDefined();
        const parsedOverlay = JSON.parse(liveOverlay!);
        expect(parsedOverlay.queuedMessages).toEqual(["follow-up one", "follow-up two"]);
        expect(parsedOverlay.model.thinking).toBe(true);
        expect(parsedOverlay.sessionName).toBe("Renamed");

        // 3. Simulate relay restart / Redis loss: the in-memory Redis shim
        //    (and therefore the overlay) disappears, but SQLite survives.
        sessionStore.clear();

        // 4. A reconnecting viewer falls back to the durable SQLite snapshot.
        const persisted = await getPersistedRelaySessionSnapshot(SESSION_ID, USER_ID);
        expect(persisted).not.toBeNull();

        // BUG: the SQLite snapshot is the *base* state; the overlay metadata
        // is gone, so queuedMessages, the model patch, and the sessionName
        // update are silently reverted.
        const state = persisted!.state as Record<string, unknown>;
        expect(state.sessionName).toBe("Base");
        expect(state.queuedMessages).toEqual([]);
        expect((state.model as Record<string, unknown>).thinking).toBeUndefined();
    });

    it("has no durable column or table for the snapshot overlay", async () => {
        // Corroborating code-path check: there is simply nowhere in the SQLite
        // schema to put the overlay. recordRelaySessionState only writes the
        // relay_session_state.state column; patchSessionSnapshotState only
        // touches the Redis session hash.
        const tables = await memDb.introspection.getTables();
        const tableNames = tables.map((t) => t.name);
        expect(tableNames).toContain("relay_session_state");

        const rsCols = tables.find((t) => t.name === "relay_session_state")?.columns.map((c) => c.name) ?? [];
        expect(rsCols).toEqual(expect.arrayContaining(["sessionId", "state", "updatedAt"]));
        expect(rsCols).not.toContain("overlay");
        expect(rsCols).not.toContain("snapshotOverlay");
    });
});
