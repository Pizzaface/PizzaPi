/**
 * SQLite cache for session analysis data.
 *
 * Tables:
 *   session_analysis  — stores serialized SessionAnalysis JSON
 *   processing_state  — stores last mtime for revalidation
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { SessionAnalysis } from "./types.js";

const DB_FILENAME = "session-analyzer.db";

/** Open or create the SQLite database in the given directory. */
export function openDb(dir: string): Database {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, DB_FILENAME));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_analysis (
      session_id TEXT PRIMARY KEY,
      analysis_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS processing_state (
      session_id TEXT PRIMARY KEY,
      last_mtime_ms INTEGER NOT NULL
    )
  `);
  return db;
}

/** Save or update cached analysis for a session. */
export function saveAnalysis(db: Database, analysis: SessionAnalysis): void {
  db.run(
    `INSERT INTO session_analysis (session_id, analysis_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       analysis_json = excluded.analysis_json,
       updated_at = excluded.updated_at`,
    [analysis.sessionId, JSON.stringify(analysis), Date.now()],
  );
}

/** Load cached analysis for a session, or null if not cached. */
export function loadAnalysis(db: Database, sessionId: string): SessionAnalysis | null {
  const row = db
    .query<{ analysis_json: string }, [string]>(
      "SELECT analysis_json FROM session_analysis WHERE session_id = ?",
    )
    .get(sessionId);
  if (!row) return null;
  try {
    return JSON.parse(row.analysis_json) as SessionAnalysis;
  } catch {
    return null;
  }
}

/** Get the last known mtime for a session file, or null if not tracked. */
export function getProcessingState(
  db: Database,
  sessionId: string,
): { lastMtimeMs: number } | null {
  const row = db
    .query<{ last_mtime_ms: number }, [string]>(
      "SELECT last_mtime_ms FROM processing_state WHERE session_id = ?",
    )
    .get(sessionId);
  return row ? { lastMtimeMs: row.last_mtime_ms } : null;
}

/** Update the processing state for a session (last known mtime). */
export function saveProcessingState(
  db: Database,
  sessionId: string,
  lastMtimeMs: number,
): void {
  db.run(
    `INSERT INTO processing_state (session_id, last_mtime_ms)
     VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       last_mtime_ms = excluded.last_mtime_ms`,
    [sessionId, lastMtimeMs],
  );
}
