import { describe, it, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initAuth, getKysely } from "../auth.js";
import {
    ensureRelaySessionTables,
    pinRelaySession,
    unpinRelaySession,
    listPersistedRelaySessionsForUser,
    listPinnedRelaySessionsForUser,
    pruneExpiredRelaySessions,
    getPersistedRelaySessionSnapshot,
} from "./store.js";

const TEST_USER_ID = "test-user-pin";
const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-pin-test-"));
const dbPath = join(tmpDir, "pin-test.db");

async function insertSession(opts: {
    sessionId: string;
    userId?: string;
    isEphemeral?: boolean;
    expiresAt?: string | null;
    isPinned?: number;
}) {
    const now = new Date().toISOString();
    await getKysely()
        .insertInto("relay_session")
        .values({
            id: opts.sessionId,
            userId: opts.userId ?? TEST_USER_ID,
            userName: null,
            cwd: "/test",
            shareUrl: `http://test/${opts.sessionId}`,
            startedAt: now,
            lastActiveAt: now,
            endedAt: null,
            isEphemeral: opts.isEphemeral === false ? 0 : 1,
            expiresAt: opts.expiresAt ?? null,
            isPinned: opts.isPinned ?? 0,
        })
        .execute();
}

beforeAll(async () => {
    initAuth({ dbPath, baseURL: "http://localhost:7777", secret: "test-secret-pin" });
    await ensureRelaySessionTables();
});

afterEach(async () => {
    await getKysely().deleteFrom("relay_session_state").execute();
    await getKysely().deleteFrom("relay_session").execute();
});

afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("pinRelaySession", () => {
    it("pins an existing session owned by the user", async () => {
        await insertSession({ sessionId: "s1" });

        const result = await pinRelaySession("s1", TEST_USER_ID);
        expect(result).toBe(true);

        const row = await getKysely()
            .selectFrom("relay_session")
            .select("isPinned")
            .where("id", "=", "s1")
            .executeTakeFirst();
        expect(row?.isPinned).toBe(1);
    });

    it("returns false for non-existent session", async () => {
        const result = await pinRelaySession("nonexistent", TEST_USER_ID);
        expect(result).toBe(false);
    });

    it("returns false when user doesn't own the session", async () => {
        await insertSession({ sessionId: "s2", userId: "other-user" });

        const result = await pinRelaySession("s2", TEST_USER_ID);
        expect(result).toBe(false);
    });

    it("is idempotent — pinning already-pinned session succeeds", async () => {
        await insertSession({ sessionId: "s3", isPinned: 1 });

        const result = await pinRelaySession("s3", TEST_USER_ID);
        expect(result).toBe(true);
    });

    it("succeeds on retry when session row appears after a delay", async () => {
        // Simulate the race: insert the row 300ms after pin is called
        // (the retry delay is 250ms, so the 2nd attempt should find it)
        const delayedInsert = setTimeout(async () => {
            await insertSession({ sessionId: "s-delayed" });
        }, 300);

        const result = await pinRelaySession("s-delayed", TEST_USER_ID);
        clearTimeout(delayedInsert);
        expect(result).toBe(true);
    });
});

describe("unpinRelaySession", () => {
    it("unpins a pinned session", async () => {
        await insertSession({ sessionId: "s4", isPinned: 1 });

        const result = await unpinRelaySession("s4", TEST_USER_ID);
        expect(result).toBe(true);

        const row = await getKysely()
            .selectFrom("relay_session")
            .select("isPinned")
            .where("id", "=", "s4")
            .executeTakeFirst();
        expect(row?.isPinned).toBe(0);
    });

    it("returns false for non-existent session", async () => {
        const result = await unpinRelaySession("nonexistent", TEST_USER_ID);
        expect(result).toBe(false);
    });

    it("returns false when user doesn't own the session", async () => {
        await insertSession({ sessionId: "s5", userId: "other-user", isPinned: 1 });

        const result = await unpinRelaySession("s5", TEST_USER_ID);
        expect(result).toBe(false);
    });
});

describe("listPersistedRelaySessionsForUser", () => {
    it("includes isPinned field in results", async () => {
        await insertSession({ sessionId: "s6", isPinned: 1, isEphemeral: false });
        await insertSession({ sessionId: "s7", isPinned: 0, isEphemeral: false });

        const sessions = await listPersistedRelaySessionsForUser(TEST_USER_ID);
        const pinned = sessions.find((s) => s.sessionId === "s6");
        const unpinned = sessions.find((s) => s.sessionId === "s7");

        expect(pinned?.isPinned).toBe(true);
        expect(unpinned?.isPinned).toBe(false);
    });

    it("pinned sessions appear before unpinned sessions", async () => {
        await insertSession({ sessionId: "s-old-pinned", isPinned: 1, isEphemeral: false });
        await insertSession({ sessionId: "s-new-unpinned", isPinned: 0, isEphemeral: false });

        const sessions = await listPersistedRelaySessionsForUser(TEST_USER_ID);
        expect(sessions.length).toBe(2);
        expect(sessions[0].sessionId).toBe("s-old-pinned");
    });

    it("includes pinned sessions even if expired", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        await insertSession({ sessionId: "s-expired-pinned", isPinned: 1, expiresAt: pastDate });
        await insertSession({ sessionId: "s-expired-unpinned", isPinned: 0, expiresAt: pastDate });

        const sessions = await listPersistedRelaySessionsForUser(TEST_USER_ID);
        const ids = sessions.map((s) => s.sessionId);

        expect(ids).toContain("s-expired-pinned");
        expect(ids).not.toContain("s-expired-unpinned");
    });
});

describe("listPinnedRelaySessionsForUser", () => {
    it("returns only pinned sessions", async () => {
        await insertSession({ sessionId: "s-only-pinned", isPinned: 1, isEphemeral: false });
        await insertSession({ sessionId: "s-only-unpinned", isPinned: 0, isEphemeral: false });

        const sessions = await listPinnedRelaySessionsForUser(TEST_USER_ID);
        const ids = sessions.map((s) => s.sessionId);

        expect(ids).toContain("s-only-pinned");
        expect(ids).not.toContain("s-only-unpinned");
    });
});

describe("getPersistedRelaySessionSnapshot", () => {
    it("returns pinned session even if expired", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await insertSession({ sessionId: "s-snap-pinned", isPinned: 1, expiresAt: pastDate });

        const snap = await getPersistedRelaySessionSnapshot("s-snap-pinned", TEST_USER_ID);
        expect(snap).not.toBeNull();
        expect(snap?.sessionId).toBe("s-snap-pinned");
    });

    it("returns null for expired unpinned session", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        await insertSession({ sessionId: "s-snap-unpinned", isPinned: 0, expiresAt: pastDate });

        const snap = await getPersistedRelaySessionSnapshot("s-snap-unpinned", TEST_USER_ID);
        expect(snap).toBeNull();
    });

    it("returns null when requesting another user's session", async () => {
        await insertSession({ sessionId: "s-snap-foreign", userId: "other-user", isPinned: 1, isEphemeral: false });

        const snap = await getPersistedRelaySessionSnapshot("s-snap-foreign", TEST_USER_ID);
        expect(snap).toBeNull();
    });
});

describe("pruneExpiredRelaySessions", () => {
    it("does not prune pinned sessions even when expired", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        await insertSession({ sessionId: "s-prune-pinned", isPinned: 1, expiresAt: pastDate });
        await insertSession({ sessionId: "s-prune-unpinned", isPinned: 0, expiresAt: pastDate });

        const pruned = await pruneExpiredRelaySessions();

        expect(pruned).toContain("s-prune-unpinned");
        expect(pruned).not.toContain("s-prune-pinned");

        // Verify pinned session still exists
        const remaining = await getKysely()
            .selectFrom("relay_session")
            .select("id")
            .where("id", "=", "s-prune-pinned")
            .executeTakeFirst();
        expect(remaining).toBeTruthy();
    });

    it("prunes expired unpinned sessions normally", async () => {
        const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        await insertSession({ sessionId: "s-prune1", isPinned: 0, expiresAt: pastDate });
        await insertSession({ sessionId: "s-prune2", isPinned: 0, expiresAt: pastDate });

        const pruned = await pruneExpiredRelaySessions();
        expect(pruned).toContain("s-prune1");
        expect(pruned).toContain("s-prune2");
    });

    it("does not prune sessions without an expiry", async () => {
        await insertSession({ sessionId: "s-no-expiry", isPinned: 0, expiresAt: null, isEphemeral: false });

        const pruned = await pruneExpiredRelaySessions();
        expect(pruned).not.toContain("s-no-expiry");
    });
});
