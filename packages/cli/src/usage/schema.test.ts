import { test, expect, mock, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const originalTmpdir = tmpdir;
let tempDir: string = "";

const osMock = {
  homedir: () => tempDir,
  tmpdir: originalTmpdir,
};

// Mock node:os so that homedir() returns a temporary directory during these tests
mock.module("node:os", () => osMock);

import { getUsageDbPath, getSessionsDir, openUsageDb } from "./schema.js";

beforeAll(() => {
  tempDir = mkdtempSync(join(originalTmpdir(), "pizzapi-schema-test-"));
});

afterAll(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("paths are correctly resolved relative to homedir", () => {
  expect(getUsageDbPath()).toBe(join(tempDir, ".pizzapi", "usage.db"));
  expect(getSessionsDir()).toBe(join(tempDir, ".pizzapi", "sessions"));
});

test("openUsageDb initializes a new database with correct schema", () => {
  const db = openUsageDb();
  expect(db).toBeDefined();

  // Verify DB file was created
  expect(existsSync(getUsageDbPath())).toBe(true);

  // Check tables
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
  const tableNames = tables.map((t: any) => t.name);
  expect(tableNames).toContain("usage_events");
  expect(tableNames).toContain("sessions");
  expect(tableNames).toContain("processing_state");

  // Check indices
  const indices = db.query("SELECT name FROM sqlite_master WHERE type='index'").all();
  const indexNames = indices.map((i: any) => i.name);
  expect(indexNames).toContain("idx_events_timestamp");
  expect(indexNames).toContain("idx_events_project");
  expect(indexNames).toContain("idx_events_model");
  expect(indexNames).toContain("idx_sessions_started");
  expect(indexNames).toContain("idx_sessions_project");

  // Check schema version is 1
  const versionInfo = db.query("PRAGMA user_version").get() as any;
  expect(versionInfo.user_version).toBe(1);

  // Check journal mode is WAL
  const journalModeInfo = db.query("PRAGMA journal_mode").get() as any;
  expect(journalModeInfo.journal_mode).toBe("wal");

  db.close();
});

test("openUsageDb opens an existing database successfully without recreation", () => {
  // First, create a database and add a dummy record
  const db1 = openUsageDb();
  db1.run("INSERT INTO processing_state (file_path, last_offset, last_modified) VALUES (?, ?, ?)", ["test.txt", 100, 1000]);
  db1.close();

  // Open it again and verify the record is still there
  const db2 = openUsageDb();
  const record = db2.query("SELECT * FROM processing_state WHERE file_path = ?").get("test.txt") as any;

  expect(record).toBeDefined();
  expect(record.last_offset).toBe(100);

  // Schema version should still be 1
  const versionInfo = db2.query("PRAGMA user_version").get() as any;
  expect(versionInfo.user_version).toBe(1);

  db2.close();
});
