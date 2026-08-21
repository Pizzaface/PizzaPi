import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openUsageDb } from "./schema.js";

function createV1Db(path: string): void {
  const db = new Database(path);
  db.run(`
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL,
      cost_input REAL,
      cost_output REAL,
      cost_cache_read REAL,
      cost_cache_write REAL,
      UNIQUE(session_id, timestamp, model)
    )
  `);
  db.run(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, session_name TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER, message_count INTEGER DEFAULT 0,
      total_input INTEGER DEFAULT 0, total_output INTEGER DEFAULT 0,
      total_cache_read INTEGER DEFAULT 0, total_cache_write INTEGER DEFAULT 0,
      total_cost REAL, primary_model TEXT, primary_provider TEXT
    )
  `);
  db.run(`
    CREATE TABLE processing_state (
      file_path TEXT PRIMARY KEY, last_offset INTEGER DEFAULT 0, last_modified INTEGER
    )
  `);
  db.run(
    `INSERT INTO usage_events (session_id, project, timestamp, provider, model, input_tokens)
     VALUES ('s1', '/p', 100, 'anthropic', 'claude-opus', 42)`,
  );
  db.run(`INSERT INTO processing_state (file_path, last_offset, last_modified) VALUES ('a/b.jsonl', 10, 1)`);
  db.run("PRAGMA user_version = 1");
  db.close();
}

describe("usage.db v1 → v2 migration", () => {
  test("preserves rows, adds event_uid, drops the (session, timestamp, model) uniqueness", () => {
    const tmpDir = mkdtempSync("/tmp/usage-migration-test-");
    const dbPath = join(tmpDir, "usage.db");
    createV1Db(dbPath);

    const db = openUsageDb(dbPath);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(2);

    // Existing row preserved with NULL uid
    const rows = db.query<any, []>("SELECT * FROM usage_events").all();
    expect(rows.length).toBe(1);
    expect(rows[0].input_tokens).toBe(42);
    expect(rows[0].event_uid).toBeNull();

    // Distinct calls sharing (session, timestamp, model) both insert now
    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model, input_tokens, event_uid)
       VALUES ('s1', '/p', 100, 'anthropic', 'claude-opus', 1, 'f:10')`,
    );
    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model, input_tokens, event_uid)
       VALUES ('s1', '/p', 100, 'anthropic', 'claude-opus', 2, 'f:20')`,
    );
    expect(db.query<any, []>("SELECT * FROM usage_events").all().length).toBe(3);

    // Same event_uid is rejected (dedup key)
    const before = db.query<any, []>("SELECT COUNT(*) c FROM usage_events").get()!.c;
    db.run(
      `INSERT OR IGNORE INTO usage_events (session_id, project, timestamp, provider, model, input_tokens, event_uid)
       VALUES ('s1', '/p', 999, 'anthropic', 'claude-opus', 3, 'f:10')`,
    );
    expect(db.query<any, []>("SELECT COUNT(*) c FROM usage_events").get()!.c).toBe(before);

    // processing_state gained the ino column and kept its row
    const st = db.query<any, []>("SELECT * FROM processing_state").get();
    expect(st.last_offset).toBe(10);
    expect(st.ino).toBeNull();
    db.close();
  });

  test("fresh database is created directly at v2", () => {
    const tmpDir = mkdtempSync("/tmp/usage-migration-test-");
    const db = openUsageDb(join(tmpDir, "usage.db"));
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(2);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(usage_events)").all().map((c) => c.name);
    expect(cols).toContain("event_uid");
    db.close();
  });
});
