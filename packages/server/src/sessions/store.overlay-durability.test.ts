/**
 * Durability test for the snapshot overlay: the metadata overlay (model,
 * session name, goal, todo, queued messages) must survive a relay restart /
 * Redis loss by being persisted to SQLite alongside the base state and
 * re-applied at read time.
 *
 * Uses mock.module to replace ../auth.js so getKysely() returns an in-memory
 * SQLite instance owned by this file (no Redis required).
 */
import { afterAll, describe, it, expect, beforeAll, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";

const memDb = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

mock.module("../auth.js", () => ({
    getKysely: () => memDb,
    createTestDatabase: () => memDb,
    _setKyselyForTest: () => {},
}));

afterAll(() => mock.restore());

import {
    ensureRelaySessionTables,
    recordRelaySessionStart,
    recordRelaySessionState,
    recordRelaySessionOverlay,
    getPersistedRelaySessionSnapshot,
} from "./store.js";
import { applySnapshotOverlayToState } from "../ws/sio-registry/snapshot-state.js";

const USER = "user-durability";

beforeAll(async () => {
    await ensureRelaySessionTables();
});

afterEach(async () => {
    await memDb.deleteFrom("relay_session_state").execute();
    await memDb.deleteFrom("relay_session").execute();
});

async function seedSession(sessionId: string): Promise<void> {
    await recordRelaySessionStart({
        sessionId,
        userId: USER,
        cwd: "/repo",
        shareUrl: `http://test/${sessionId}`,
        startedAt: new Date().toISOString(),
        isEphemeral: false,
    });
}

describe("snapshot overlay durability", () => {
    it("persists the overlay alongside the base state and re-applies it after a simulated restart", async () => {
        const sessionId = "dur-1";
        await seedSession(sessionId);

        // Base state (full snapshot) — carries no metadata yet.
        const baseState = { messages: [{ role: "user", content: "hello" }] };
        await recordRelaySessionState(sessionId, USER, baseState);

        // Metadata patches accumulate in the overlay (Redis-only in the old
        // design; now also persisted to SQLite).
        const overlay = {
            model: { id: "sonnet", provider: "anthropic" },
            sessionName: "Durable session",
            goal: { text: "ship the fix" },
            todoList: [{ id: 1, text: "persist overlay" }],
            queuedMessages: [{ role: "user", content: "queued" }],
        };
        await recordRelaySessionOverlay(sessionId, USER, JSON.stringify(overlay));

        // Simulate restart: reconstruct purely from SQLite (no Redis).
        const snapshot = await getPersistedRelaySessionSnapshot(sessionId, USER);
        expect(snapshot).not.toBeNull();
        expect(snapshot!.state).toEqual(baseState);
        expect(snapshot!.snapshotOverlay).toBe(JSON.stringify(overlay));

        // Re-apply the overlay at read time — metadata must survive.
        const reconstructed = applySnapshotOverlayToState(snapshot!.state, snapshot!.snapshotOverlay) as Record<
            string,
            unknown
        >;
        expect(reconstructed.model).toEqual({ id: "sonnet", provider: "anthropic" });
        expect(reconstructed.sessionName).toBe("Durable session");
        expect(reconstructed.goal).toEqual({ text: "ship the fix" });
        expect(reconstructed.todoList).toEqual([{ id: 1, text: "persist overlay" }]);
        expect(reconstructed.queuedMessages).toEqual([{ role: "user", content: "queued" }]);
        // Base state is preserved underneath the overlay.
        expect(reconstructed.messages).toEqual(baseState.messages);
    });

    it("clears the persisted overlay when a full snapshot is written", async () => {
        const sessionId = "dur-2";
        await seedSession(sessionId);

        await recordRelaySessionState(sessionId, USER, { messages: [] });
        await recordRelaySessionOverlay(sessionId, USER, JSON.stringify({ sessionName: "stale" }));

        // A full snapshot carries fresh metadata — the overlay is now stale.
        await recordRelaySessionState(sessionId, USER, { messages: [], sessionName: "fresh" });

        const snapshot = await getPersistedRelaySessionSnapshot(sessionId, USER);
        expect(snapshot!.snapshotOverlay).toBeNull();
    });

    it("is a no-op when no state row exists yet (overlay has no base to apply to)", async () => {
        const sessionId = "dur-3";
        await seedSession(sessionId);

        // No recordRelaySessionState call — the state row does not exist.
        await recordRelaySessionOverlay(sessionId, USER, JSON.stringify({ sessionName: "orphan" }));

        const snapshot = await getPersistedRelaySessionSnapshot(sessionId, USER);
        expect(snapshot!.state).toBeNull();
        expect(snapshot!.snapshotOverlay).toBeNull();
    });
});
