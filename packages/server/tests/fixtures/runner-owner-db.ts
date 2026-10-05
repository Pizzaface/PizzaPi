/**
 * Test fixture: back the durable runner_owner table with a disposable
 * in-memory SQLite database for unit tests that call registerRunner() (or
 * other runner-owner code) without a full auth context.
 *
 * Runner registration fails CLOSED when the durable owner store is
 * unavailable, so suites exercising registration need a working store.
 *
 * Call (and await) BEFORE importing the modules under test so their
 * `getKysely` import resolves to the in-memory database. Intended for suites
 * run one-file-per-process (scripts/test-isolated.ts), since mock.module is
 * process-global.
 */
import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import * as actualAuth from "../../src/auth.js";

export interface RunnerOwnerTestDb {
    db: Kysely<any>;
    /** Remove every durable owner row (call from beforeEach). */
    reset(): Promise<void>;
    /** Make every subsequent query throw until restored (fail-closed tests). */
    setBroken(broken: boolean): void;
}

export async function installRunnerOwnerTestDb(): Promise<RunnerOwnerTestDb> {
    const db = new Kysely<any>({ dialect: new BunSqliteDialect({ database: new Database(":memory:") }) });
    let broken = false;
    mock.module("../../src/auth.js", () => ({
        ...actualAuth,
        getKysely: () => {
            if (broken) throw new Error("runner_owner store unavailable (test)");
            return db;
        },
    }));
    const { ensureRunnerOwnerTable } = await import("../../src/runner-owner.js");
    await ensureRunnerOwnerTable();
    return {
        db,
        reset: async () => {
            await db.deleteFrom("runner_owner").execute();
        },
        setBroken: (value: boolean) => {
            broken = value;
        },
    };
}
