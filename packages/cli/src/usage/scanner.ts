import { Database } from "bun:sqlite";
import { readFileSync, statSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionHeader, UsageMessage } from "./types.js";
import { getSessionsDir } from "./schema.js";

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
): void {
  const sessionId = sessionHeader.id;
  const project = sessionHeader.cwd;
  const startedAtMs = new Date(sessionHeader.timestamp).getTime();

  // Read the full file if content wasn't provided
  if (!fullContent) {
    fullContent = readFileSync(filePath, "utf-8");
  }

  // Handle incremental processing: if we have a lastOffset, process only new lines
  let linesToProcess: string[];
  if (lastOffset !== undefined && lastOffset > 0) {
    // lastOffset points to the byte position we've already processed up to
    // If lastOffset >= fullContent.length, there's no new content
    if (lastOffset >= fullContent.length) {
      linesToProcess = [];
    } else {
      // Start from lastOffset
      // If there's a newline at lastOffset (shouldn't happen), skip it
      let startPos = lastOffset;
      if (startPos < fullContent.length && fullContent[startPos] === "\n") {
        startPos++;
      }
      // Process only the new content
      const newContent = fullContent.slice(startPos);
      linesToProcess = newContent.split("\n");
    }
  } else {
    // First scan: process all lines (skip the header in the processing loop)
    linesToProcess = fullContent.split("\n");
  }

  // Track usage data
  interface UsageEvent {
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
  let lastMessageTimestamp = startedAtMs;
  let messageCount = 0;

  // Model usage tracking (by count)
  const modelUsage = new Map<string, number>();

  // For incremental scans, we need to get existing session data to merge with
  let existingSession: any = null;
  if (lastOffset !== undefined && lastOffset > 0) {
    existingSession = db
      .query<any, [string]>("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId);
  }

  // Track the byte position of the last complete line we process
  let lastCompleteLineOffset = lastOffset ?? 0;

  // Process each line
  for (let i = 0; i < linesToProcess.length; i++) {
    const line = linesToProcess[i];
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);

      // Skip the session header (already have it)
      if (obj.type === "session") {
        // Mark this line as successfully processed
        lastCompleteLineOffset += Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
        continue;
      }

      // Check for session name
      if (obj.type === "message" && !sessionName) {
        const name = extractSessionName(line);
        if (name) sessionName = name;
      }

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

        lastMessageTimestamp = Math.max(lastMessageTimestamp, timestamp);
        messageCount++;

        const provider = msg.provider || "unknown";
        const model = msg.model || "unknown";

        // Track model usage
        modelUsage.set(model, (modelUsage.get(model) || 0) + 1);

        const event: UsageEvent = {
          timestamp,
          provider,
          model,
          input_tokens: usage.input || 0,
          output_tokens: usage.output || 0,
          cache_read_tokens: usage.cacheRead || 0,
          cache_write_tokens: usage.cacheWrite || 0,
          cost_usd: usage.cost?.total ?? null,
          cost_input: usage.cost?.input ?? null,
          cost_output: usage.cost?.output ?? null,
          cost_cache_read: usage.cost?.cacheRead ?? null,
          cost_cache_write: usage.cost?.cacheWrite ?? null,
        };

        events.push(event);

        // Mark this line as successfully processed
        lastCompleteLineOffset += Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
      } else {
        // For other valid JSON types (like message without usage), still mark as processed
        lastCompleteLineOffset += Buffer.byteLength(line, "utf-8") + 1; // +1 for newline
      }
    } catch {
      // Skip malformed lines — don't update lastCompleteLineOffset for malformed lines
    }
  }

  // Determine primary model (most used by count)
  let primaryModel = "unknown";
  let primaryProvider = "unknown";
  if (modelUsage.size > 0) {
    primaryModel = [...modelUsage.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // Extract provider from first matching event
    const firstEvent = events.find((e) => e.model === primaryModel);
    if (firstEvent) {
      primaryProvider = firstEvent.provider;
    }
  }

  // Aggregate totals
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost: number | null = null;

  for (const event of events) {
    totalInput += event.input_tokens;
    totalOutput += event.output_tokens;
    totalCacheRead += event.cache_read_tokens;
    totalCacheWrite += event.cache_write_tokens;

    // Sum cost (skip null values)
    if (event.cost_usd !== null) {
      totalCost = (totalCost ?? 0) + event.cost_usd;
    }
  }

  // For incremental scans, merge with existing data
  if (existingSession && messageCount > 0) {
    totalInput += existingSession.total_input || 0;
    totalOutput += existingSession.total_output || 0;
    totalCacheRead += existingSession.total_cache_read || 0;
    totalCacheWrite += existingSession.total_cache_write || 0;
    if (existingSession.total_cost !== null) {
      totalCost = (totalCost ?? 0) + existingSession.total_cost;
    }
    messageCount += existingSession.message_count || 0;
  }

  // Use transaction for atomicity
  db.transaction(() => {
    // Insert usage events
    for (const event of events) {
      db.run(
        `INSERT OR IGNORE INTO usage_events 
         (session_id, project, timestamp, provider, model, 
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ],
      );
    }

    // Upsert session summary
    db.run(
      `INSERT INTO sessions 
       (id, project, session_name, started_at, ended_at, message_count,
        total_input, total_output, total_cache_read, total_cache_write,
        total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
       session_name = COALESCE(excluded.session_name, session_name),
       ended_at = CASE WHEN excluded.ended_at IS NULL THEN ended_at ELSE MAX(ended_at, excluded.ended_at) END,
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
        messageCount > 0 ? lastMessageTimestamp : null,
        messageCount,
        totalInput,
        totalOutput,
        totalCacheRead,
        totalCacheWrite,
        totalCost,
        primaryModel,
        primaryProvider,
      ],
    );

    // Update processing state with byte offset (only for the lines we actually processed)
    const fileStats = statSync(filePath);
    db.run(
      `INSERT INTO processing_state (file_path, last_offset, last_modified)
       VALUES (?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
       last_offset = excluded.last_offset,
       last_modified = excluded.last_modified`,
      [relativePath, lastCompleteLineOffset, fileStats.mtimeMs],
    );
  })();
}

/**
 * Scan all session directories and process new/changed JSONL files.
 * Idempotent — can be called repeatedly.
 */
export async function scanSessions(db: Database): Promise<void> {
  const primaryDir = getSessionsDir();
  const piDir = join(homedir(), ".pi", "agent", "sessions");

  const dirsToScan = [];
  if (existsSync(primaryDir)) {
    dirsToScan.push(primaryDir);
  }
  if (existsSync(piDir) && piDir !== primaryDir) {
    dirsToScan.push(piDir);
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
          .query<{ last_offset: number; last_modified: number }, [string]>(
            "SELECT last_offset, last_modified FROM processing_state WHERE file_path = ?",
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

        // Process the file, passing content to avoid double read
        // and passing lastOffset for incremental processing
        try {
          processFile(db, filePath, relativePath, sessionHeader, content, state?.last_offset);
        } catch (e) {
          console.error(`Error processing ${filePath}:`, e);
        }
      }
    }
  }
}
