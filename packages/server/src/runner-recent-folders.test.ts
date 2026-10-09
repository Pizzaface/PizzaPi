import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { sql } from "kysely";
import {
    recordRecentFolder,
    getRecentFolders,
    deleteRecentFolder,
    ensureRunnerRecentFoldersTable,
    mergeDuplicateFolderRows,
} from "./runner-recent-folders.js";
import { createTestAuthContext, getKysely, runWithAuthContext } from "./auth.js";

const USER = "user-1";
const RUNNER = "runner-1";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-recent-folders-test-"));
const dbPath = join(tmpDir, "test.db");
const authContext = createTestAuthContext({ dbPath });
const withAuth = <T>(fn: () => T): T => runWithAuthContext(authContext, fn);
const authTest = (name: string, fn: () => Promise<void> | void) => test(name, () => withAuth(fn));

beforeAll(async () => {
    await withAuth(() => ensureRunnerRecentFoldersTable());
});

beforeEach(async () => {
    // Truncate rows for a clean slate (table already exists in temp DB).
    await withAuth(() => getKysely().deleteFrom("runner_recent_folder").execute());
});

afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("recordRecentFolder", () => {
    authTest("records a new folder", async () => {
        await recordRecentFolder(USER, RUNNER, "/code/project");
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders).toEqual(["/code/project"]);
    });

    authTest("ignores empty / whitespace paths", async () => {
        await recordRecentFolder(USER, RUNNER, "");
        await recordRecentFolder(USER, RUNNER, "   ");
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders).toHaveLength(0);
    });

    authTest("upserts — updates lastUsedAt but does not duplicate", async () => {
        await recordRecentFolder(USER, RUNNER, "/code/project");
        await recordRecentFolder(USER, RUNNER, "/code/project");
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders).toHaveLength(1);
    });

    authTest("sorts by usage count before recency", async () => {
        await recordRecentFolder(USER, RUNNER, "/code/once");
        await recordRecentFolder(USER, RUNNER, "/code/often");
        await recordRecentFolder(USER, RUNNER, "/code/often");
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders).toEqual(["/code/often", "/code/once"]);
    });

    authTest("prunes lowest-usage entries beyond cap of 50", async () => {
        // Distinct timestamps make project-3 the oldest low-usage folder;
        // real-clock millisecond ties are otherwise resolved by random UUID.
        for (let i = 1; i <= 50; i++) {
            const path = `/code/project-${i}`;
            await recordRecentFolder(USER, RUNNER, path);
            await getKysely().updateTable("runner_recent_folder")
                .set({ lastUsedAt: new Date(Date.UTC(2026, 0, 1) + i * 1_000).toISOString() })
                .where("userId", "=", USER).where("runnerId", "=", RUNNER).where("path", "=", path)
                .execute();
        }
        await recordRecentFolder(USER, RUNNER, "/code/project-1");
        await recordRecentFolder(USER, RUNNER, "/code/project-2");
        await recordRecentFolder(USER, RUNNER, "/code/project-51");
        await recordRecentFolder(USER, RUNNER, "/code/project-52");

        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders).toHaveLength(50);
        expect(new Set(folders).size).toBe(50);
        expect(folders).toContain("/code/project-1");
        expect(folders).toContain("/code/project-2");
        expect(folders).not.toContain("/code/project-3");
        expect(folders).not.toContain("/code/project-4");
    });

    authTest("cap is per (userId, runnerId) pair", async () => {
        const RUNNER_B = "runner-2";
        for (let i = 1; i <= 52; i++) {
            await recordRecentFolder(USER, RUNNER, `/code/project-${i}`);
        }
        // A different runner should have independent cap
        await recordRecentFolder(USER, RUNNER_B, "/code/other");
        const foldersB = await getRecentFolders(USER, RUNNER_B);
        expect(foldersB).toHaveLength(1);
        const foldersA = await getRecentFolders(USER, RUNNER);
        expect(foldersA).toHaveLength(50);
    });

    authTest("trims path whitespace before storing", async () => {
        await recordRecentFolder(USER, RUNNER, "  /code/project  ");
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders[0]).toBe("/code/project");
    });

    authTest("concurrent records of the same path never create duplicate rows", async () => {
        // Regression for GM EqNrZtr1: select-then-insert let two concurrent
        // calls both miss the not-yet-committed row and insert duplicates,
        // splitting usage counts and eating cap entries.
        await Promise.all([
            recordRecentFolder(USER, RUNNER, "/code/race"),
            recordRecentFolder(USER, RUNNER, "/code/race"),
            recordRecentFolder(USER, RUNNER, "/code/race"),
        ]);

        const rows = await getKysely()
            .selectFrom("runner_recent_folder")
            .select(["id", "usageCount"])
            .where("userId", "=", USER)
            .where("runnerId", "=", RUNNER)
            .where("path", "=", "/code/race")
            .execute();

        expect(rows).toHaveLength(1);
        expect(rows[0].usageCount).toBe(3);
    });
});

describe("deleteRecentFolder", () => {
    authTest("removes the folder and returns true", async () => {
        await recordRecentFolder(USER, RUNNER, "/code/project");
        const deleted = await deleteRecentFolder(USER, RUNNER, "/code/project");
        expect(deleted).toBe(true);
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders).toHaveLength(0);
    });

    authTest("returns false when folder does not exist", async () => {
        const deleted = await deleteRecentFolder(USER, RUNNER, "/code/nonexistent");
        expect(deleted).toBe(false);
    });
});

describe("mergeDuplicateFolderRows", () => {
    // Regression for GM EqNrZtr1: the old merge did its UPDATE and DELETE as
    // two separate statements. A crash between them (or a second server
    // process running the same startup migration at the same moment) could
    // leave the merged sum committed on the surviving row AND still find the
    // not-yet-deleted duplicate, so re-running the merge summed them again
    // (2 + 3 -> 5, then 5 + 3 -> 8). Wrapping the whole merge in one
    // transaction makes an interrupted run roll back cleanly instead of
    // leaving that half-applied state behind.
    test("a failure between the UPDATE and DELETE rolls back instead of leaving a half-merged row", async () => {
        // Own temp DB with the table but WITHOUT the unique index yet —
        // mirroring an existing installation that still has duplicate rows
        // from the old select-then-insert race (see
        // ensureRunnerRecentFoldersTable). The shared suite DB above already
        // has the unique index, which would reject these duplicate inserts.
        const dir = mkdtempSync(join(tmpdir(), "pizzapi-recent-folders-merge-test-"));
        const ctx = createTestAuthContext({ dbPath: join(dir, "test.db") });
        try {
            await runWithAuthContext(ctx, async () => {
                await getKysely().schema
                    .createTable("runner_recent_folder")
                    .ifNotExists()
                    .addColumn("id", "text", (col) => col.primaryKey())
                    .addColumn("userId", "text", (col) => col.notNull())
                    .addColumn("runnerId", "text", (col) => col.notNull())
                    .addColumn("path", "text", (col) => col.notNull())
                    .addColumn("lastUsedAt", "text", (col) => col.notNull())
                    .addColumn("usageCount", "integer", (col) => col.notNull().defaultTo(1))
                    .execute();

                await getKysely().insertInto("runner_recent_folder").values({
                    id: "dup-a",
                    userId: USER,
                    runnerId: RUNNER,
                    path: "/code/dup",
                    lastUsedAt: "2026-01-01T00:00:00.000Z",
                    usageCount: 2,
                }).execute();
                await getKysely().insertInto("runner_recent_folder").values({
                    id: "dup-b",
                    userId: USER,
                    runnerId: RUNNER,
                    path: "/code/dup",
                    lastUsedAt: "2026-01-02T00:00:00.000Z",
                    usageCount: 3,
                }).execute();

                // Simulate "crashes right before the DELETE" with a trigger
                // that aborts any delete from this table. If the UPDATE and
                // DELETE aren't in the same transaction, the UPDATE commits
                // anyway and the duplicate row survives — the exact half-
                // merged state that double-counts on the next run.
                await sql`
                    CREATE TRIGGER fail_delete_dup
                    BEFORE DELETE ON runner_recent_folder
                    BEGIN
                        SELECT RAISE(ABORT, 'simulated crash before delete');
                    END
                `.execute(getKysely());

                await expect(mergeDuplicateFolderRows()).rejects.toThrow();

                const midRows = await getKysely()
                    .selectFrom("runner_recent_folder")
                    .select(["id", "usageCount"])
                    .where("userId", "=", USER)
                    .where("runnerId", "=", RUNNER)
                    .where("path", "=", "/code/dup")
                    .orderBy("id", "asc")
                    .execute();
                // Both original rows must be untouched — the failed DELETE
                // must have rolled back the UPDATE too, not left it committed.
                expect(midRows).toEqual([
                    { id: "dup-a", usageCount: 2 },
                    { id: "dup-b", usageCount: 3 },
                ]);

                await sql`DROP TRIGGER fail_delete_dup`.execute(getKysely());

                // A clean run now correctly merges the still-pristine duplicate.
                await mergeDuplicateFolderRows();
                const finalRows = await getKysely()
                    .selectFrom("runner_recent_folder")
                    .select(["id", "usageCount"])
                    .where("userId", "=", USER)
                    .where("runnerId", "=", RUNNER)
                    .where("path", "=", "/code/dup")
                    .execute();
                expect(finalRows).toHaveLength(1);
                expect(finalRows[0].usageCount).toBe(5);
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // Regression for GM EqNrZtr1 round 2: the dedupe used to COMMIT, then
    // separately run CREATE UNIQUE INDEX as its own statement. During a
    // rolling upgrade, an older relay node still running the pre-fix
    // select-then-insert recordRecentFolder() could land a fresh duplicate in
    // the gap between those two statements, so CREATE UNIQUE INDEX then
    // failed outright with "UNIQUE constraint failed" and the server never
    // finished starting (confirmed with an isolated SQLite interleaving
    // probe). The fix folds both into ONE `BEGIN IMMEDIATE ... COMMIT`
    // transaction, so the write lock is held across the whole thing and no
    // concurrent writer can land in between.
    //
    // This spies on every statement bun:sqlite prepares during the merge to
    // prove that property directly, rather than trying to force genuine
    // thread-level interleaving against the real SQL timing: the pre-fix
    // code opens with a plain `begin` (not `begin immediate`) and commits
    // before the separate CREATE UNIQUE INDEX call, so both assertions below
    // fail against it.
    test("dedupe and unique-index creation share one BEGIN IMMEDIATE...COMMIT transaction", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pizzapi-recent-folders-tx-test-"));
        const ctx = createTestAuthContext({ dbPath: join(dir, "test.db") });
        try {
            await runWithAuthContext(ctx, async () => {
                await getKysely().schema
                    .createTable("runner_recent_folder")
                    .ifNotExists()
                    .addColumn("id", "text", (col) => col.primaryKey())
                    .addColumn("userId", "text", (col) => col.notNull())
                    .addColumn("runnerId", "text", (col) => col.notNull())
                    .addColumn("path", "text", (col) => col.notNull())
                    .addColumn("lastUsedAt", "text", (col) => col.notNull())
                    .addColumn("usageCount", "integer", (col) => col.notNull().defaultTo(1))
                    .execute();

                await getKysely().insertInto("runner_recent_folder").values({
                    id: "dup-a",
                    userId: USER,
                    runnerId: RUNNER,
                    path: "/code/dup",
                    lastUsedAt: "2026-01-01T00:00:00.000Z",
                    usageCount: 2,
                }).execute();
                await getKysely().insertInto("runner_recent_folder").values({
                    id: "dup-b",
                    userId: USER,
                    runnerId: RUNNER,
                    path: "/code/dup",
                    lastUsedAt: "2026-01-02T00:00:00.000Z",
                    usageCount: 3,
                }).execute();

                const statements: string[] = [];
                const originalPrepare = Database.prototype.prepare;
                // ponytail: monkeypatching a global prototype method is the only
                // way to observe the exact SQL text/order Kysely's Bun SQLite
                // driver issues (it calls db.prepare() directly) without adding a
                // logging seam to production code for one test.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (Database.prototype as any).prepare = function (this: Database, sqlText: string, ...rest: unknown[]) {
                    statements.push(sqlText);
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    return (originalPrepare as any).call(this, sqlText, ...rest);
                };
                try {
                    await mergeDuplicateFolderRows();
                } finally {
                    Database.prototype.prepare = originalPrepare;
                }

                const relevant = statements.filter(
                    (s) => /^(begin|commit|rollback)/i.test(s.trim()) || /runner_recent_folder/i.test(s),
                );

                const beginIdx = relevant.findIndex((s) => /^begin/i.test(s.trim()));
                expect(beginIdx).toBeGreaterThanOrEqual(0);
                // Plain `begin` (deferred) takes no lock until the first write --
                // a dedupe run with nothing to merge would leave the exact same
                // race. Must be BEGIN IMMEDIATE.
                expect(relevant[beginIdx].trim().toLowerCase()).toBe("begin immediate");

                const createIndexIdx = relevant.findIndex((s) => /create unique index/i.test(s));
                expect(createIndexIdx).toBeGreaterThan(beginIdx);

                // No commit/rollback between acquiring the lock and creating the
                // index -- i.e. they're the same transaction, not two.
                const between = relevant.slice(beginIdx + 1, createIndexIdx);
                expect(between.some((s) => /^(commit|rollback)/i.test(s.trim()))).toBe(false);

                // And it really commits afterward (lock isn't left held).
                const commitAfterIdx = relevant.findIndex(
                    (s, i) => i > createIndexIdx && /^commit/i.test(s.trim()),
                );
                expect(commitAfterIdx).toBeGreaterThan(createIndexIdx);

                // Behavioral outcome: the duplicate is merged and the index now
                // enforces uniqueness going forward.
                const rows = await getKysely()
                    .selectFrom("runner_recent_folder")
                    .select(["id", "usageCount"])
                    .where("userId", "=", USER)
                    .where("runnerId", "=", RUNNER)
                    .where("path", "=", "/code/dup")
                    .execute();
                expect(rows).toHaveLength(1);
                expect(rows[0].usageCount).toBe(5);

                await expect(
                    getKysely().insertInto("runner_recent_folder").values({
                        id: "dup-c",
                        userId: USER,
                        runnerId: RUNNER,
                        path: "/code/dup",
                        lastUsedAt: "2026-01-03T00:00:00.000Z",
                        usageCount: 1,
                    }).execute(),
                ).rejects.toThrow(/unique/i);
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
