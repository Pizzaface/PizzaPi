import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordRecentFolder, getRecentFolders, deleteRecentFolder, ensureRunnerRecentFoldersTable } from "./runner-recent-folders.js";
import { createTestDatabase, _setKyselyForTest, getKysely } from "./auth.js";

const USER = "user-1";
const RUNNER = "runner-1";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-recent-folders-test-"));
const dbPath = join(tmpDir, "test.db");

// Own Kysely instance — immune to other test files clobbering the singleton.
const testDb = createTestDatabase(dbPath);

beforeAll(async () => {
    _setKyselyForTest(testDb);
    await ensureRunnerRecentFoldersTable();
});

beforeEach(async () => {
    // Re-pin before every test — another file's beforeAll may have overwritten _kysely.
    _setKyselyForTest(testDb);
    // Truncate rows for a clean slate (table already exists in temp DB).
    await getKysely().deleteFrom("runner_recent_folder").execute();
});

afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("recordRecentFolder", () => {
    test("records a new folder", async () => {
        await recordRecentFolder(USER, RUNNER, "/code/project");
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders).toEqual(["/code/project"]);
    });

    test("ignores empty / whitespace paths", async () => {
        await recordRecentFolder(USER, RUNNER, "");
        await recordRecentFolder(USER, RUNNER, "   ");
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders).toHaveLength(0);
    });

    test("upserts — updates lastUsedAt but does not duplicate", async () => {
        await recordRecentFolder(USER, RUNNER, "/code/project");
        await recordRecentFolder(USER, RUNNER, "/code/project");
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders).toHaveLength(1);
    });

    test("returns most-recent-first order", async () => {
        await recordRecentFolder(USER, RUNNER, "/code/a");
        await recordRecentFolder(USER, RUNNER, "/code/b");
        await recordRecentFolder(USER, RUNNER, "/code/c");
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders[0]).toBe("/code/c");
        expect(folders[1]).toBe("/code/b");
        expect(folders[2]).toBe("/code/a");
    });

    test("prunes oldest entries beyond cap of 50", async () => {
        // Insert 52 distinct paths
        for (let i = 1; i <= 52; i++) {
            await recordRecentFolder(USER, RUNNER, `/code/project-${i}`);
        }
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders).toHaveLength(50);
        // Most recent should be retained
        expect(folders[0]).toBe("/code/project-52");
        expect(folders[1]).toBe("/code/project-51");
        // Oldest should be pruned
        expect(folders.includes("/code/project-1")).toBe(false);
        expect(folders.includes("/code/project-2")).toBe(false);
    });

    test("cap is per (userId, runnerId) pair", async () => {
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

    test("trims path whitespace before storing", async () => {
        await recordRecentFolder(USER, RUNNER, "  /code/project  ");
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders[0]).toBe("/code/project");
    });
});

describe("deleteRecentFolder", () => {
    test("removes the folder and returns true", async () => {
        await recordRecentFolder(USER, RUNNER, "/code/project");
        const deleted = await deleteRecentFolder(USER, RUNNER, "/code/project");
        expect(deleted).toBe(true);
        const folders = await getRecentFolders(USER, RUNNER);
        expect(folders).toHaveLength(0);
    });

    test("returns false when folder does not exist", async () => {
        const deleted = await deleteRecentFolder(USER, RUNNER, "/code/nonexistent");
        expect(deleted).toBe(false);
    });
});
