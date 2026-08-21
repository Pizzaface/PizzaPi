import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const SCHEMA_VERSION = 2;

export function getUsageDbPath(): string {
  return join(homedir(), ".pizzapi", "usage.db");
}

export function getSessionsDir(): string {
  // Primary directory — scanner also checks legacy dirs as fallback
  return join(homedir(), ".pizzapi", "sessions");
}

export function openUsageDb(dbPath: string = getUsageDbPath()): Database {
  mkdirSync(join(dbPath, ".."), { recursive: true });

  const db = new Database(dbPath);

  // Enable WAL for concurrent read/write
  db.run("PRAGMA journal_mode=WAL");

  const currentVersion = db.query<{ user_version: number }, []>(
    "PRAGMA user_version"
  ).get()?.user_version ?? 0;

  if (currentVersion < SCHEMA_VERSION) {
    db.transaction(() => {
      if (currentVersion < 1) {
        db.run(`
          CREATE TABLE IF NOT EXISTS usage_events (
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
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            project TEXT NOT NULL,
            session_name TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            message_count INTEGER DEFAULT 0,
            total_input INTEGER DEFAULT 0,
            total_output INTEGER DEFAULT 0,
            total_cache_read INTEGER DEFAULT 0,
            total_cache_write INTEGER DEFAULT 0,
            total_cost REAL,
            primary_model TEXT,
            primary_provider TEXT
          )
        `);

        db.run(`
          CREATE TABLE IF NOT EXISTS processing_state (
            file_path TEXT PRIMARY KEY,
            last_offset INTEGER DEFAULT 0,
            last_modified INTEGER
          )
        `);

        db.run("CREATE INDEX IF NOT EXISTS idx_events_timestamp ON usage_events(timestamp)");
        db.run("CREATE INDEX IF NOT EXISTS idx_events_project ON usage_events(project)");
        db.run("CREATE INDEX IF NOT EXISTS idx_events_model ON usage_events(model)");
        db.run("CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)");
        db.run("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project)");
      }

      if (currentVersion < 2) {
        // v2: replace the UNIQUE(session_id, timestamp, model) constraint —
        // which collides distinct API calls sharing a timestamp — with a
        // file-offset-derived event_uid. Existing rows keep event_uid = NULL
        // (SQLite unique indexes permit multiple NULLs).
        db.run(`
          CREATE TABLE usage_events_v2 (
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
            event_uid TEXT
          )
        `);
        db.run(`
          INSERT INTO usage_events_v2
            (id, session_id, project, timestamp, provider, model,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write, event_uid)
          SELECT id, session_id, project, timestamp, provider, model,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write, NULL
          FROM usage_events
        `);
        db.run("DROP TABLE usage_events");
        db.run("ALTER TABLE usage_events_v2 RENAME TO usage_events");
        db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uid ON usage_events(event_uid)");
        db.run("CREATE INDEX IF NOT EXISTS idx_events_timestamp ON usage_events(timestamp)");
        db.run("CREATE INDEX IF NOT EXISTS idx_events_project ON usage_events(project)");
        db.run("CREATE INDEX IF NOT EXISTS idx_events_model ON usage_events(model)");
        db.run("CREATE INDEX IF NOT EXISTS idx_events_session ON usage_events(session_id)");
        // Track file identity so a rewritten (replaced-inode) session file
        // triggers a rebuild of that file's accounting.
        db.run("ALTER TABLE processing_state ADD COLUMN ino INTEGER");
      }

      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
  }

  return db;
}
