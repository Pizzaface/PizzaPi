import { Database } from "bun:sqlite";
import { readFileSync, statSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@pizzapi/tools";
import type { SessionHeader, UsageMessage } from "./types.js";
import { getSessionsDir } from "./schema.js";
import { GOAL_EVALUATOR_USAGE_CUSTOM_TYPE } from "../extensions/goal/state.js";

const log = createLogger("usage");

export interface ParsedSessionHeader extends SessionHeader {}

/**
 * Parse a JSONL line as a session header.
 * Returns the header if it's a valid session header, null otherwise.
 */
export function parseSessionHeader(line: string): ParsedSessionHeader | null {
  try {
    const obj = JSON.parse(line);
    if (obj.type === "session" && obj.id && obj.cwd) {
      return obj as ParsedSessionHeader;
    }
  } catch {
    // JSON parse error — skip
  }
  return null;
}

/**
 * Extract session name from a message line containing set_session_name tool call.
 */
export function extractSessionName(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    if (obj.type !== "message" || !obj.message) return null;

    const msg = obj.message;
    if (!msg.tool_calls || !Array.isArray(msg.tool_calls)) return null;

    for (const call of msg.tool_calls) {
      if (call.name === "set_session_name" && call.arguments) {
        try {
          const args = typeof call.arguments === "string" 
            ? JSON.parse(call.arguments) 
            : call.arguments;
          if (args.name && typeof args.name === "string") {
            return args.name;
          }
        } catch {
          // Skip if arguments can't be parsed
        }
      }
    }
  } catch {
    // JSON parse error — skip
  }
  return null;
}

/**
 * Process a single JSONL file and insert/update usage events and sessions.
 * Called with a session header that was already parsed from the file.
 * If fullContent is provided, it will be used instead of reading from disk.
 * If lastOffset is provided, will process only new lines after that byte offset.
 */
export function processFile(
  db: Database,
  filePath: string,
  relativePath: string,
  sessionHeader: SessionHeader,
  fullContent?: string,
  lastOffset?: number,
  opts?: { rebuild?: boolean },
): void {
  const sessionId = sessionHeader.id;
  const project = sessionHeader.cwd;
  const startedAtMs = new Date(sessionHeader.timestamp).getTime();
  const rebuild = opts?.rebuild === true;

  // Read the full file if content wasn't provided
  if (!fullContent) {
    fullContent = readFileSync(filePath, "utf-8");
  }

  // All offsets are UTF-8 byte offsets; operate on a Buffer so multi-byte
  // characters can never cause offset drift.
  const fullBuf = Buffer.from(fullContent, "utf-8");
  let pos = lastOffset !== undefined && lastOffset > 0 && !rebuild ? lastOffset : 0;
  if (pos > fullBuf.length) pos = fullBuf.length;
  // If there's a newline byte at pos (shouldn't happen), skip it
  if (pos > 0 && pos < fullBuf.length && fullBuf[pos] === 0x0a /* '\n' */) {
    pos++;
  }

  // Track usage data
  interface UsageEvent {
    event_uid: string;
    timestamp: number;
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number | null;
    cost_input: number | null;
    cost_output: number | null;
    cost_cache_read: number | null;
    cost_cache_write: number | null;
  }

  const events: UsageEvent[] = [];
  let sessionName: string | null = null;

  // Byte offset just past the last successfully processed, newline-terminated
  // line. A trailing line with no newline (still being written) or the first
  // malformed line stops processing — the offset records its exact byte start
  // so the next scan retries from there instead of desyncing.
  let lastCompleteLineOffset = pos;

  while (pos < fullBuf.length) {
    const nl = fullBuf.indexOf(0x0a, pos);
    if (nl === -1) break; // incomplete final line — don't consume it
    const lineStart = pos;
    const line = fullBuf.slice(pos, nl).toString("utf-8");
    pos = nl + 1;

    if (!line.trim()) {
      lastCompleteLineOffset = pos;
      continue;
    }

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      // Malformed complete line: stop here and record its byte start so the
      // offset stays in sync with what was actually accounted.
      lastCompleteLineOffset = lineStart;
      break;
    }

    // Skip the session header (already have it)
    if (obj.type === "session") {
      lastCompleteLineOffset = pos;
      continue;
    }

    // Check for session name
    if (obj.type === "message" && !sessionName) {
      const name = extractSessionName(line);
      if (name) sessionName = name;
    }

    // Stable per-line event ID: file identity + absolute byte start of the
    // line. Deterministic across replays, unique across distinct API calls.
    const eventUid = `${relativePath}:${lineStart}`;

    // Extract usage from assistant messages
    if (
      obj.type === "message" &&
      obj.message &&
      obj.message.role === "assistant" &&
      obj.message.usage
    ) {
      const msg = obj.message as any;
      const usage = msg.usage;
      const timestamp = new Date(obj.timestamp).getTime();

      events.push({
        event_uid: eventUid,
        timestamp,
        provider: msg.provider || "unknown",
        model: msg.model || "unknown",
        input_tokens: usage.input || 0,
        output_tokens: usage.output || 0,
        cache_read_tokens: usage.cacheRead || 0,
        cache_write_tokens: usage.cacheWrite || 0,
        cost_usd: usage.cost?.total ?? null,
        cost_input: usage.cost?.input ?? null,
        cost_output: usage.cost?.output ?? null,
        cost_cache_read: usage.cost?.cacheRead ?? null,
        cost_cache_write: usage.cost?.cacheWrite ?? null,
      });
    } else if (obj.type === "custom" && obj.customType === GOAL_EVALUATOR_USAGE_CUSTOM_TYPE) {
      // /goal LLM evaluator calls are separate API requests outside the
      // normal turn — surface their spend here so it isn't invisible to
      // the Usage dashboard. Written as a per-call delta (see state.ts),
      // so it's safe to add directly without cumulative double-counting.
      const data = obj.data as { provider?: string; model?: string; tokens?: number; cost?: number; timestamp?: number };
      const timestamp = data.timestamp ?? new Date(obj.timestamp).getTime();

      events.push({
        event_uid: eventUid,
        timestamp,
        provider: data.provider || "unknown",
        model: data.model || "unknown",
        input_tokens: 0,
        output_tokens: data.tokens || 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: data.cost ?? null,
        cost_input: null,
        cost_output: data.cost ?? null,
        cost_cache_read: null,
        cost_cache_write: null,
      });
    }
    lastCompleteLineOffset = pos;
  }

  // Use transaction for atomicity
  db.transaction(() => {
    if (rebuild) {
      // File was truncated or replaced — drop this file's previous accounting
      // before re-inserting. Also drops legacy (pre-event_uid) rows for this
      // session so they can't double-count against the replay.
      // ponytail: legacy NULL-uid delete is session-wide; fine because a
      // session's usage lives in one jsonl file in practice.
      const likePrefix = `${relativePath.replace(/([%_\\])/g, "\\$1")}:%`;
      db.run(
        "DELETE FROM usage_events WHERE event_uid LIKE ? ESCAPE '\\' OR (session_id = ? AND event_uid IS NULL)",
        [likePrefix, sessionId],
      );
    }

    // Insert usage events — OR IGNORE on event_uid makes replays no-ops.
    for (const event of events) {
      db.run(
        `INSERT OR IGNORE INTO usage_events 
         (session_id, project, timestamp, provider, model, 
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write, event_uid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          project,
          event.timestamp,
          event.provider,
          event.model,
          event.input_tokens,
          event.output_tokens,
          event.cache_read_tokens,
          event.cache_write_tokens,
          event.cost_usd,
          event.cost_input,
          event.cost_output,
          event.cost_cache_read,
          event.cost_cache_write,
          event.event_uid,
        ],
      );
    }

    // Derive the session summary from persisted events — the single source of
    // truth. Replayed (ignored) inserts therefore can never inflate summaries,
    // and rebuilds are automatically consistent.
    if (events.length > 0 || rebuild) {
      const agg = db
        .query<any, [string]>(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(input_tokens), 0) AS total_input,
                  COALESCE(SUM(output_tokens), 0) AS total_output,
                  COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
                  COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write,
                  SUM(cost_usd) AS total_cost,
                  MAX(timestamp) AS last_ts
           FROM usage_events WHERE session_id = ?`,
        )
        .get(sessionId);
      const primary = db
        .query<{ model: string; provider: string }, [string]>(
          `SELECT model, provider FROM usage_events WHERE session_id = ?
           GROUP BY model, provider ORDER BY COUNT(*) DESC LIMIT 1`,
        )
        .get(sessionId);

      db.run(
        `INSERT INTO sessions 
         (id, project, session_name, started_at, ended_at, message_count,
          total_input, total_output, total_cache_read, total_cache_write,
          total_cost, primary_model, primary_provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
         session_name = COALESCE(excluded.session_name, session_name),
         ended_at = excluded.ended_at,
         message_count = excluded.message_count,
         total_input = excluded.total_input,
         total_output = excluded.total_output,
         total_cache_read = excluded.total_cache_read,
         total_cache_write = excluded.total_cache_write,
         total_cost = excluded.total_cost,
         primary_model = excluded.primary_model,
         primary_provider = excluded.primary_provider`,
        [
          sessionId,
          project,
          sessionName,
          startedAtMs,
          agg?.last_ts ?? null,
          agg?.n ?? 0,
          agg?.total_input ?? 0,
          agg?.total_output ?? 0,
          agg?.total_cache_read ?? 0,
          agg?.total_cache_write ?? 0,
          agg?.total_cost ?? null,
          primary?.model ?? "unknown",
          primary?.provider ?? "unknown",
        ],
      );
    }

    // Update processing state with byte offset (only for the lines we actually processed)
    const fileStats = statSync(filePath);
    db.run(
      `INSERT INTO processing_state (file_path, last_offset, last_modified, ino)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
       last_offset = excluded.last_offset,
       last_modified = excluded.last_modified,
       ino = excluded.ino`,
      [relativePath, lastCompleteLineOffset, fileStats.mtimeMs, fileStats.ino ?? null],
    );
  })();
}

/**
 * Scan all session directories and process new/changed JSONL files.
 * Idempotent — can be called repeatedly.
 */
export async function scanSessions(db: Database): Promise<void> {
  const primaryDir = getSessionsDir();
  // Legacy fallback directories for unmigrated installs
  const legacyDirs = [
    join(homedir(), ".pizzapi", "agent", "sessions"),
    join(homedir(), ".pi", "agent", "sessions"),
  ];

  const dirsToScan = [];
  if (existsSync(primaryDir)) {
    dirsToScan.push(primaryDir);
  }
  for (const legacyDir of legacyDirs) {
    if (existsSync(legacyDir) && legacyDir !== primaryDir && !dirsToScan.includes(legacyDir)) {
      dirsToScan.push(legacyDir);
    }
  }

  for (const sessionsDir of dirsToScan) {
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(sessionsDir);
    } catch {
      // Directory doesn't exist or can't be read
      continue;
    }

    for (const sessionDirName of sessionDirs) {
      const sessionPath = join(sessionsDir, sessionDirName);
      let files: string[];

      try {
        files = await readdir(sessionPath);
      } catch {
        // Can't read directory
        continue;
      }

      for (const fileName of files) {
        if (!fileName.endsWith(".jsonl")) continue;

        const filePath = join(sessionPath, fileName);
        const relativePath = join(sessionDirName, fileName);

        // Check if we need to process this file
        const state = db
          .query<{ last_offset: number; last_modified: number; ino: number | null }, [string]>(
            "SELECT last_offset, last_modified, ino FROM processing_state WHERE file_path = ?",
          )
          .get(relativePath);

        let fileStats: ReturnType<typeof statSync>;
        try {
          fileStats = statSync(filePath);
        } catch {
          // File doesn't exist anymore
          continue;
        }

        // Skip if file hasn't changed
        if (state && state.last_modified === fileStats.mtimeMs) {
          continue;
        }

        // Read the file once
        const content = readFileSync(filePath, "utf-8");
        const firstLine = content.split("\n")[0];
        const sessionHeader = parseSessionHeader(firstLine);

        if (!sessionHeader) {
          // Skip files without valid session header
          continue;
        }

        // Truncated (size < recorded offset) or replaced (inode changed) file:
        // the recorded accounting no longer matches the bytes on disk — rebuild
        // this file's accounting from scratch instead of silently keeping it.
        const rebuild =
          state !== null &&
          state !== undefined &&
          (fileStats.size < state.last_offset ||
            (state.ino !== null && state.ino !== undefined && Number(state.ino) !== Number(fileStats.ino)));

        // Process the file, passing content to avoid double read
        // and passing lastOffset for incremental processing
        try {
          processFile(db, filePath, relativePath, sessionHeader, content, rebuild ? undefined : state?.last_offset, { rebuild });
        } catch (e) {
          log.error(`Error processing ${filePath}:`, e);
        }
      }
    }
  }
}
