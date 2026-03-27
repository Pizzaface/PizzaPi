import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const SCHEMA_VERSION = 1;

export function getUsageDbPath(): string {
  return join(homedir(), ".pizzapi", "usage.db");
}

export function getSessionsDir(): string {
  // Primary directory — scanner also checks legacy dirs as fallback
  return join(homedir(), ".pizzapi", "sessions");
}

export function openUsageDb(): Database {
  const dbPath = getUsageDbPath();
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

      db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
  }

  return db;
}
