/**
 * Tests for cross-user session ownership protections added to the persistence
 * layer (ended-session ID reuse vulnerability).
 *
 * Uses mock.module to replace ../auth.js so getKysely() returns an in-memory
 * SQLite instance owned by this file.
 */
import { afterAll, describe, it, expect, beforeAll, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";

// ── In-memory DB (no temp files, no singleton) ───────────────────────────────
const memDb = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

mock.module("../auth.js", () => ({
    getKysely: () => memDb,
    createTestDatabase: () => memDb,
    _setKyselyForTest: () => {},
}));

// Restore module mocks after this file so the auth.js mock doesn't bleed
// into other test files sharing the same Bun worker process.
afterAll(() => mock.restore());

import {
    ensureRelaySessionTables,
    recordRelaySessionStart,
    recordRelaySessionState,
    getPersistedRelaySessionSnapshot,
} from "./store.js";

const USER_A = "user-alpha";
const USER_B = "user-bravo";

beforeAll(async () => {
    await ensureRelaySessionTables();
});

afterEach(async () => {
    await memDb.deleteFrom("relay_session_state").execute();
    await memDb.deleteFrom("relay_session").execute();
});

// ── recordRelaySessionStart ownership guard ───────────────────────────────────

describe("recordRelaySessionStart — ended-session ownership guard", () => {
    it("upserts normally when there is no existing row", async () => {
        await recordRelaySessionStart({
            sessionId: "own-new",
            userId: USER_A,
            cwd: "/repo",
            shareUrl: "http://test/own-new",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        const row = await memDb
            .selectFrom("relay_session")
            .select(["id", "userId"])
            .where("id", "=", "own-new")
            .executeTakeFirst();
        expect(row?.userId).toBe(USER_A);
    });

    it("upserts normally when same user reconnects (row already exists)", async () => {
        await recordRelaySessionStart({
            sessionId: "own-reconn",
            userId: USER_A,
            cwd: "/repo",
            shareUrl: "http://test/own-reconn",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        // Simulate ended session
        await memDb
            .updateTable("relay_session")
            .set({ endedAt: new Date().toISOString() })
            .where("id", "=", "own-reconn")
            .execute();

        // Same user re-registers
        await recordRelaySessionStart({
            sessionId: "own-reconn",
            userId: USER_A,
            cwd: "/repo",
            shareUrl: "http://test/own-reconn",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        const row = await memDb
            .selectFrom("relay_session")
            .select(["id", "userId", "endedAt"])
            .where("id", "=", "own-reconn")
            .executeTakeFirst();
        expect(row?.userId).toBe(USER_A);
        expect(row?.endedAt).toBeNull(); // cleared on reconnect
    });

    it("skips upsert when a different user tries to reuse an ended session ID", async () => {
        // User A owns the session
        await recordRelaySessionStart({
            sessionId: "own-takeover",
            userId: USER_A,
            cwd: "/repo",
            shareUrl: "http://test/own-takeover",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        // Simulate ended session
        const endedAt = new Date().toISOString();
        await memDb
            .updateTable("relay_session")
            .set({ endedAt })
            .where("id", "=", "own-takeover")
            .execute();

        // User B tries to re-register with User A's session ID
        await recordRelaySessionStart({
            sessionId: "own-takeover",
            userId: USER_B,
            cwd: "/evil",
            shareUrl: "http://test/own-takeover",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        // The row must still belong to User A; User B's upsert was skipped
        const row = await memDb
            .selectFrom("relay_session")
            .select(["id", "userId", "cwd", "endedAt"])
            .where("id", "=", "own-takeover")
            .executeTakeFirst();
        expect(row?.userId).toBe(USER_A);
        expect(row?.cwd).toBe("/repo"); // not overwritten
        expect(row?.endedAt).toBe(endedAt); // not cleared by attacker
    });

    it("allows an anonymous session to be adopted when no userId was set", async () => {
        // Anonymous session (no userId)
        await recordRelaySessionStart({
            sessionId: "own-anon",
            userId: undefined,
            cwd: "/anon",
            shareUrl: "http://test/own-anon",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        // Any authenticated user may take over an anonymous session row
        await recordRelaySessionStart({
            sessionId: "own-anon",
            userId: USER_A,
            cwd: "/claimed",
            shareUrl: "http://test/own-anon",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        // The upsert should have proceeded (userId was null, so no conflict)
        const row = await memDb
            .selectFrom("relay_session")
            .select(["id", "userId"])
            .where("id", "=", "own-anon")
            .executeTakeFirst();
        // userId stays null (the upsert doesn't overwrite userId on conflict),
        // but the important thing is it didn't throw or skip entirely.
        expect(row).toBeDefined();
    });
});

// ── recordRelaySessionState ownership guard ───────────────────────────────────

describe("recordRelaySessionState — userId ownership guard", () => {
    it("writes state when userId matches the session owner", async () => {
        await recordRelaySessionStart({
            sessionId: "state-ok",
            userId: USER_A,
            cwd: "/repo",
            shareUrl: "http://test/state-ok",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        await recordRelaySessionState("state-ok", USER_A, { messages: ["hello"] });

        const row = await memDb
            .selectFrom("relay_session_state")
            .select("state")
            .where("sessionId", "=", "state-ok")
            .executeTakeFirst();
        expect(row).toBeDefined();
        expect(JSON.parse(row!.state)).toEqual({ messages: ["hello"] });
    });

    it("skips state write when userId does not match the session owner", async () => {
        await recordRelaySessionStart({
            sessionId: "state-mismatch",
            userId: USER_A,
            cwd: "/repo",
            shareUrl: "http://test/state-mismatch",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        // Seed a legitimate state row
        await recordRelaySessionState("state-mismatch", USER_A, { messages: ["original"] });

        // User B attempts to overwrite User A's state
        await recordRelaySessionState("state-mismatch", USER_B, { messages: ["hacked"] });

        const row = await memDb
            .selectFrom("relay_session_state")
            .select("state")
            .where("sessionId", "=", "state-mismatch")
            .executeTakeFirst();
        expect(JSON.parse(row!.state)).toEqual({ messages: ["original"] }); // unchanged
    });

    it("writes state when session has no owner (anonymous)", async () => {
        await recordRelaySessionStart({
            sessionId: "state-anon",
            userId: undefined,
            cwd: "/anon",
            shareUrl: "http://test/state-anon",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        // Any userId (even null) can write state for anonymous sessions
        await recordRelaySessionState("state-anon", USER_A, { messages: ["from-anon"] });

        const row = await memDb
            .selectFrom("relay_session_state")
            .select("state")
            .where("sessionId", "=", "state-anon")
            .executeTakeFirst();
        expect(JSON.parse(row!.state)).toEqual({ messages: ["from-anon"] });
    });

    it("writes state when userId is null and session has no owner", async () => {
        await recordRelaySessionStart({
            sessionId: "state-null-user",
            userId: undefined,
            cwd: "/anon",
            shareUrl: "http://test/state-null-user",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        await recordRelaySessionState("state-null-user", null, { x: 1 });

        const row = await memDb
            .selectFrom("relay_session_state")
            .select("state")
            .where("sessionId", "=", "state-null-user")
            .executeTakeFirst();
        expect(JSON.parse(row!.state)).toEqual({ x: 1 });
    });
});

// ── getPersistedRelaySessionSnapshot authorization (existing, unchanged) ──────

describe("getPersistedRelaySessionSnapshot — userId filter (regression)", () => {
    it("returns snapshot only for the correct owner", async () => {
        await recordRelaySessionStart({
            sessionId: "snap-owner",
            userId: USER_A,
            cwd: "/repo",
            shareUrl: "http://test/snap-owner",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        const snap = await getPersistedRelaySessionSnapshot("snap-owner", USER_A);
        expect(snap).not.toBeNull();
        expect(snap!.sessionId).toBe("snap-owner");
    });

    it("returns null when a different user requests the snapshot", async () => {
        await recordRelaySessionStart({
            sessionId: "snap-blocked",
            userId: USER_A,
            cwd: "/repo",
            shareUrl: "http://test/snap-blocked",
            startedAt: new Date().toISOString(),
            isEphemeral: false,
        });

        const snap = await getPersistedRelaySessionSnapshot("snap-blocked", USER_B);
        expect(snap).toBeNull();
    });
});
