import { afterAll, describe, it, expect, afterEach, beforeAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { getEphemeralSweepIntervalMs, getEphemeralTtlMs } from "./store.js";

// ── In-memory DB for pagination tests ────────────────────────────────────────
const paginationDb = new Kysely<any>({
    dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

// We need a separate import of the store module with mocked auth for DB tests.
// But since the existing tests already import from store.js without mocking,
// we use a dynamic approach: set up the mock BEFORE dynamic import.
const paginationStorePromise = (async () => {
    // This mock only applies to the dynamically imported module below
    mock.module("../auth.js", () => ({
        getKysely: () => paginationDb,
        createTestDatabase: () => paginationDb,
        _setKyselyForTest: () => {},
    }));
    // Dynamic import so the mock is active
    return await import("./store.js");
})();

// Restore module mocks after this file so the auth.js mock doesn't bleed
// into other test files sharing the same Bun worker process.
afterAll(() => mock.restore());

describe("store.ts", () => {
    describe("getEphemeralSweepIntervalMs", () => {
        const ORIGINAL_ENV = process.env.PIZZAPI_EPHEMERAL_SWEEP_MS;

        afterEach(() => {
            if (ORIGINAL_ENV === undefined) {
                delete process.env.PIZZAPI_EPHEMERAL_SWEEP_MS;
            } else {
                process.env.PIZZAPI_EPHEMERAL_SWEEP_MS = ORIGINAL_ENV;
            }
        });

        it("should return the default value when env var is not set", () => {
            delete process.env.PIZZAPI_EPHEMERAL_SWEEP_MS;
            expect(getEphemeralSweepIntervalMs()).toBe(60 * 1000);
        });

        it("should return the parsed value when env var is a valid positive integer", () => {
            process.env.PIZZAPI_EPHEMERAL_SWEEP_MS = "120000";
            expect(getEphemeralSweepIntervalMs()).toBe(120000);
        });

        it("should return the default value when env var is zero", () => {
            process.env.PIZZAPI_EPHEMERAL_SWEEP_MS = "0";
            expect(getEphemeralSweepIntervalMs()).toBe(60 * 1000);
        });

        it("should return the default value when env var is a negative integer", () => {
            process.env.PIZZAPI_EPHEMERAL_SWEEP_MS = "-5000";
            expect(getEphemeralSweepIntervalMs()).toBe(60 * 1000);
        });

        it("should return the default value when env var is not a number", () => {
            process.env.PIZZAPI_EPHEMERAL_SWEEP_MS = "abc";
            expect(getEphemeralSweepIntervalMs()).toBe(60 * 1000);
        });

        it("should return the default value when env var is an empty string", () => {
            process.env.PIZZAPI_EPHEMERAL_SWEEP_MS = "";
            expect(getEphemeralSweepIntervalMs()).toBe(60 * 1000);
        });
    });

    describe("getEphemeralTtlMs", () => {
        const ORIGINAL_ENV = process.env.PIZZAPI_EPHEMERAL_TTL_MS;

        afterEach(() => {
            if (ORIGINAL_ENV === undefined) {
                delete process.env.PIZZAPI_EPHEMERAL_TTL_MS;
            } else {
                process.env.PIZZAPI_EPHEMERAL_TTL_MS = ORIGINAL_ENV;
            }
        });

        it("should return the default value when env var is not set", () => {
            delete process.env.PIZZAPI_EPHEMERAL_TTL_MS;
            expect(getEphemeralTtlMs()).toBe(10 * 60 * 1000);
        });

        it("should return the parsed value when env var is a valid positive integer", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "300000";
            expect(getEphemeralTtlMs()).toBe(300000);
        });

        it("should return the default value when env var is zero", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "0";
            expect(getEphemeralTtlMs()).toBe(10 * 60 * 1000);
        });

        it("should return the default value when env var is a negative integer", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "-10000";
            expect(getEphemeralTtlMs()).toBe(10 * 60 * 1000);
        });

        it("should return the default value when env var is not a number", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "invalid";
            expect(getEphemeralTtlMs()).toBe(10 * 60 * 1000);
        });

        it("should return the default value when env var is an empty string", () => {
            process.env.PIZZAPI_EPHEMERAL_TTL_MS = "";
            expect(getEphemeralTtlMs()).toBe(10 * 60 * 1000);
        });
    });
});

// ── Cursor-based pagination tests ────────────────────────────────────────────
// TODO(ltl2EKmU): mock.module doesn't isolate getKysely in CI — Bun single-process singleton clobbering
const isCI = !!process.env.CI;
const describeDB = isCI ? describe.skip : describe;

const TEST_USER = "pagination-test-user";

async function insertPaginationSession(opts: {
    sessionId: string;
    lastActiveAt: string;
    isPinned?: number;
    isEphemeral?: boolean;
    expiresAt?: string | null;
}) {
    await paginationDb
        .insertInto("relay_session")
        .values({
            id: opts.sessionId,
            userId: TEST_USER,
            userName: null,
            cwd: "/test",
            shareUrl: `http://test/${opts.sessionId}`,
            startedAt: opts.lastActiveAt,
            lastActiveAt: opts.lastActiveAt,
            endedAt: null,
            isEphemeral: opts.isEphemeral === true ? 1 : 0,
            expiresAt: opts.expiresAt ?? null,
            isPinned: opts.isPinned ?? 0,
            runnerId: null,
            runnerName: null,
        })
        .execute();
}

describeDB("listPersistedRelaySessionsForUser — cursor pagination", () => {
    let store: Awaited<typeof paginationStorePromise>;

    beforeAll(async () => {
        store = await paginationStorePromise;
        await store.ensureRelaySessionTables();
    });

    afterEach(async () => {
        await paginationDb.deleteFrom("relay_session_state").execute();
        await paginationDb.deleteFrom("relay_session").execute();
    });

    it("returns all sessions when count <= limit (no cursor)", async () => {
        await insertPaginationSession({ sessionId: "s1", lastActiveAt: "2025-01-03T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s2", lastActiveAt: "2025-01-02T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s3", lastActiveAt: "2025-01-01T00:00:00.000Z" });

        const result = await store.listPersistedRelaySessionsForUser(TEST_USER, 10);
        expect(result.sessions).toHaveLength(3);
        expect(result.nextCursor).toBeNull();
        // Ordered by lastActiveAt desc
        expect(result.sessions[0].sessionId).toBe("s1");
        expect(result.sessions[2].sessionId).toBe("s3");
    });

    it("returns first page with nextCursor when more rows exist", async () => {
        await insertPaginationSession({ sessionId: "s1", lastActiveAt: "2025-01-05T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s2", lastActiveAt: "2025-01-04T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s3", lastActiveAt: "2025-01-03T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s4", lastActiveAt: "2025-01-02T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s5", lastActiveAt: "2025-01-01T00:00:00.000Z" });

        const page1 = await store.listPersistedRelaySessionsForUser(TEST_USER, 2);
        expect(page1.sessions.map((s: any) => s.sessionId)).toEqual(["s1", "s2"]);
        expect(page1.nextCursor).toBe("2025-01-04T00:00:00.000Z");
    });

    it("returns second page using cursor, then final page with null cursor", async () => {
        await insertPaginationSession({ sessionId: "s1", lastActiveAt: "2025-01-05T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s2", lastActiveAt: "2025-01-04T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s3", lastActiveAt: "2025-01-03T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s4", lastActiveAt: "2025-01-02T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s5", lastActiveAt: "2025-01-01T00:00:00.000Z" });

        const page1 = await store.listPersistedRelaySessionsForUser(TEST_USER, 2);
        expect(page1.nextCursor).not.toBeNull();

        const page2 = await store.listPersistedRelaySessionsForUser(TEST_USER, 2, page1.nextCursor!);
        expect(page2.sessions.map((s: any) => s.sessionId)).toContain("s3");
        expect(page2.sessions.map((s: any) => s.sessionId)).toContain("s4");
        expect(page2.nextCursor).not.toBeNull();

        const page3 = await store.listPersistedRelaySessionsForUser(TEST_USER, 2, page2.nextCursor!);
        // Only s5 left (non-pinned)
        const nonPinned = page3.sessions.filter((s: any) => !s.isPinned);
        expect(nonPinned.map((s: any) => s.sessionId)).toEqual(["s5"]);
        expect(page3.nextCursor).toBeNull();
    });

    it("pinned sessions are always included regardless of cursor", async () => {
        // Pinned session has an old lastActiveAt that would be before the cursor
        await insertPaginationSession({ sessionId: "pinned1", lastActiveAt: "2024-01-01T00:00:00.000Z", isPinned: 1 });
        await insertPaginationSession({ sessionId: "s1", lastActiveAt: "2025-01-03T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s2", lastActiveAt: "2025-01-02T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s3", lastActiveAt: "2025-01-01T00:00:00.000Z" });

        // Use a cursor that would exclude the pinned session by date
        const result = await store.listPersistedRelaySessionsForUser(TEST_USER, 10, "2025-01-02T00:00:00.000Z");
        const ids = result.sessions.map((s: any) => s.sessionId);
        // Pinned session must still be present
        expect(ids).toContain("pinned1");
        // s1 should NOT be present (lastActiveAt >= cursor)
        expect(ids).not.toContain("s1");
        // s3 should be present (lastActiveAt < cursor)
        expect(ids).toContain("s3");
    });

    it("hasMore is false when exactly limit rows exist", async () => {
        await insertPaginationSession({ sessionId: "s1", lastActiveAt: "2025-01-02T00:00:00.000Z" });
        await insertPaginationSession({ sessionId: "s2", lastActiveAt: "2025-01-01T00:00:00.000Z" });

        const result = await store.listPersistedRelaySessionsForUser(TEST_USER, 2);
        expect(result.sessions).toHaveLength(2);
        expect(result.nextCursor).toBeNull();
    });

    it("no cursor, default limit returns PaginatedPersistedSessions shape", async () => {
        const result = await store.listPersistedRelaySessionsForUser(TEST_USER);
        expect(result).toHaveProperty("sessions");
        expect(result).toHaveProperty("nextCursor");
        expect(Array.isArray(result.sessions)).toBe(true);
        expect(result.nextCursor).toBeNull();
    });
});
