import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openUsageDb } from "./schema.js";
import { processFile, parseSessionHeader, extractSessionName } from "./scanner.js";

describe("Scanner", () => {
  test("parseSessionHeader parses valid session header", () => {
    const line = JSON.stringify({
      type: "session",
      version: 1,
      id: "session-123",
      timestamp: "2026-03-23T12:00:00Z",
      cwd: "/home/user/projects/pizzapi",
    });

    const result = parseSessionHeader(line);
    expect(result).toBeTruthy();
    expect(result?.id).toBe("session-123");
    expect(result?.cwd).toBe("/home/user/projects/pizzapi");
  });

  test("parseSessionHeader returns null for non-session lines", () => {
    const line = JSON.stringify({
      type: "message",
      id: "msg-123",
    });

    const result = parseSessionHeader(line);
    expect(result).toBeNull();
  });

  test("extractSessionName finds set_session_name in tool calls", () => {
    const line = JSON.stringify({
      type: "message",
      timestamp: "2026-03-23T12:00:00Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus",
        tool_calls: [
          {
            tool_call_id: "call-123",
            name: "set_session_name",
            arguments: JSON.stringify({
              name: "My Test Session",
            }),
          },
        ],
      },
    });

    const result = extractSessionName(line);
    expect(result).toBe("My Test Session");
  });

  test("extractSessionName returns null when no session name found", () => {
    const line = JSON.stringify({
      type: "message",
      timestamp: "2026-03-23T12:00:00Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus",
      },
    });

    const result = extractSessionName(line);
    expect(result).toBeNull();
  });

  test("processFile correctly parses JSONL with usage data", () => {
    // Create temp directory
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const dbPath = join(tmpDir, "test.db");
    const filePath = join(tmpDir, "session.jsonl");

    // Create JSONL file
    const sessionHeader = {
      type: "session",
      version: 1,
      id: "session-001",
      timestamp: "2026-03-23T12:00:00Z",
      cwd: "/project/test",
    } as const;

    const usageMessage = {
      type: "message",
      id: "msg-001",
      timestamp: "2026-03-23T12:05:00Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
          totalTokens: 165,
          cost: {
            total: 0.001,
            input: 0.0005,
            output: 0.0004,
            cacheRead: 0.00005,
            cacheWrite: 0.000001,
          },
        },
      },
    };

    const content = `${JSON.stringify(sessionHeader)}\n${JSON.stringify(usageMessage)}\n`;
    writeFileSync(filePath, content);

    // Process the file
    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode=WAL");
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
      CREATE TABLE processing_state (
        file_path TEXT PRIMARY KEY,
        last_offset INTEGER DEFAULT 0,
        last_modified INTEGER
      )
    `);

    processFile(db, filePath, "session.jsonl", sessionHeader);

    // Verify usage_events was inserted
    const events = db.query<any, []>("SELECT * FROM usage_events").all();
    expect(events.length).toBe(1);
    expect(events[0].session_id).toBe("session-001");
    expect(events[0].project).toBe("/project/test");
    expect(events[0].model).toBe("claude-opus");
    expect(events[0].input_tokens).toBe(100);
    expect(events[0].output_tokens).toBe(50);
    expect(events[0].cost_usd).toBeCloseTo(0.001, 6);

    // Verify sessions was upserted
    const sessions = db.query<any, []>("SELECT * FROM sessions").all();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("session-001");
    expect(sessions[0].message_count).toBe(1);
    expect(sessions[0].total_input).toBe(100);

    db.close();
  });

  test("processFile skips malformed JSON lines without crashing", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const dbPath = join(tmpDir, "test.db");
    const filePath = join(tmpDir, "session.jsonl");

    const sessionHeader = {
      type: "session",
      version: 1,
      id: "session-002",
      timestamp: "2026-03-23T12:00:00Z",
      cwd: "/project/test",
    } as const;

    // Content with a malformed JSON line
    const content = `${JSON.stringify(sessionHeader)}\nmalformed json line\n`;
    writeFileSync(filePath, content);

    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode=WAL");
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
      CREATE TABLE processing_state (
        file_path TEXT PRIMARY KEY,
        last_offset INTEGER DEFAULT 0,
        last_modified INTEGER
      )
    `);

    // Should not throw
    processFile(db, filePath, "session.jsonl", sessionHeader);

    // Should have no events (malformed line was skipped)
    const events = db.query<any, []>("SELECT * FROM usage_events").all();
    expect(events.length).toBe(0);

    db.close();
  });

  test("processFile handles sessions with no cost data", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const dbPath = join(tmpDir, "test.db");
    const filePath = join(tmpDir, "session.jsonl");

    const sessionHeader = {
      type: "session",
      version: 1,
      id: "session-003",
      timestamp: "2026-03-23T12:00:00Z",
      cwd: "/project/test",
    } as const;

    const usageMessage = {
      type: "message",
      id: "msg-001",
      timestamp: "2026-03-23T12:05:00Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          // No cost field
        },
      },
    };

    const content = `${JSON.stringify(sessionHeader)}\n${JSON.stringify(usageMessage)}\n`;
    writeFileSync(filePath, content);

    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode=WAL");
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
      CREATE TABLE processing_state (
        file_path TEXT PRIMARY KEY,
        last_offset INTEGER DEFAULT 0,
        last_modified INTEGER
      )
    `);

    processFile(db, filePath, "session.jsonl", sessionHeader);

    // Verify event was inserted with NULL cost
    const events = db.query<any, []>("SELECT * FROM usage_events").all();
    expect(events.length).toBe(1);
    expect(events[0].cost_usd).toBeNull();

    db.close();
  });

  test("processFile handles incremental processing correctly", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const dbPath = join(tmpDir, "test.db");
    const filePath = join(tmpDir, "session.jsonl");

    const sessionHeader = {
      type: "session",
      version: 1,
      id: "session-004",
      timestamp: "2026-03-23T12:00:00Z",
      cwd: "/project/test",
    } as const;

    const usageMessage1 = {
      type: "message",
      id: "msg-001",
      timestamp: "2026-03-23T12:05:00Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          cost: {
            total: 0.001,
            input: 0.0005,
            output: 0.0004,
            cacheRead: 0.00005,
            cacheWrite: 0.000001,
          },
        },
      },
    };

    // Write initial file with header + one message
    let content = `${JSON.stringify(sessionHeader)}\n${JSON.stringify(usageMessage1)}\n`;
    writeFileSync(filePath, content);

    // Set up database
    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode=WAL");
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
      CREATE TABLE processing_state (
        file_path TEXT PRIMARY KEY,
        last_offset INTEGER DEFAULT 0,
        last_modified INTEGER
      )
    `);

    // First scan: process initial file
    processFile(db, filePath, "session.jsonl", sessionHeader, content);

    // Verify first message was processed
    let events = db.query<any, []>("SELECT * FROM usage_events").all();
    expect(events.length).toBe(1);
    let sessions = db.query<any, []>("SELECT * FROM sessions").all();
    expect(sessions.length).toBe(1);
    expect(sessions[0].message_count).toBe(1);
    expect(sessions[0].total_input).toBe(100);

    // Get the stored offset
    const state = db
      .query<{ last_offset: number }, []>("SELECT last_offset FROM processing_state")
      .get();
    expect(state).toBeTruthy();
    const firstScanOffset = state!.last_offset;

    // Append a second message
    const usageMessage2 = {
      type: "message",
      id: "msg-002",
      timestamp: "2026-03-23T12:10:00Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus",
        usage: {
          input: 200,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 300,
          cost: {
            total: 0.002,
            input: 0.001,
            output: 0.0008,
            cacheRead: 0.0001,
            cacheWrite: 0.000002,
          },
        },
      },
    };

    content = `${JSON.stringify(sessionHeader)}\n${JSON.stringify(usageMessage1)}\n${JSON.stringify(usageMessage2)}\n`;
    writeFileSync(filePath, content);

    // Second scan: incremental processing with lastOffset
    processFile(db, filePath, "session.jsonl", sessionHeader, content, firstScanOffset);

    // Verify both messages are now in the database
    events = db.query<any, []>("SELECT * FROM usage_events").all();
    expect(events.length).toBe(2);

    sessions = db.query<any, []>("SELECT * FROM sessions").all();
    expect(sessions.length).toBe(1);
    expect(sessions[0].message_count).toBe(2);
    expect(sessions[0].total_input).toBe(300); // 100 + 200
    expect(sessions[0].total_output).toBe(150); // 50 + 100

    db.close();
  });

  test("processFile handles partial lines correctly", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const dbPath = join(tmpDir, "test.db");
    const filePath = join(tmpDir, "session.jsonl");

    const sessionHeader = {
      type: "session",
      version: 1,
      id: "session-005",
      timestamp: "2026-03-23T12:00:00Z",
      cwd: "/project/test",
    } as const;

    const usageMessage1 = {
      type: "message",
      id: "msg-001",
      timestamp: "2026-03-23T12:05:00Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus",
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          cost: {
            total: 0.001,
            input: 0.0005,
            output: 0.0004,
            cacheRead: 0.00005,
            cacheWrite: 0.000001,
          },
        },
      },
    };

    const usageMessage2 = {
      type: "message",
      id: "msg-002",
      timestamp: "2026-03-23T12:10:00Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus",
        usage: {
          input: 200,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 300,
          cost: {
            total: 0.002,
            input: 0.001,
            output: 0.0008,
            cacheRead: 0.0001,
            cacheWrite: 0.000002,
          },
        },
      },
    };

    // Write file with one complete message and a partial line (cut mid-JSON)
    const completeMsg = JSON.stringify(usageMessage2);
    const partialLine = completeMsg.slice(0, 50); // Cut the message mid-way, no newline
    let content = `${JSON.stringify(sessionHeader)}\n${JSON.stringify(usageMessage1)}\n${partialLine}`;
    writeFileSync(filePath, content);

    // Set up database
    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode=WAL");
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
      CREATE TABLE processing_state (
        file_path TEXT PRIMARY KEY,
        last_offset INTEGER DEFAULT 0,
        last_modified INTEGER
      )
    `);

    // First scan: should process complete message but skip partial line (no trailing newline)
    processFile(db, filePath, "session.jsonl", sessionHeader, content);

    // Verify only the complete message was processed (not the partial line)
    let events = db.query<any, []>("SELECT * FROM usage_events").all();
    expect(events.length).toBe(1); // Only message1 should be processed
    let sessions = db.query<any, []>("SELECT * FROM sessions").all();
    expect(sessions[0].message_count).toBe(1);

    // Get the stored offset (should be after the first complete message's newline)
    const state = db
      .query<{ last_offset: number }, []>("SELECT last_offset FROM processing_state")
      .get();
    const firstScanOffset = state!.last_offset;

    // Now complete the partial line and add a new complete line
    content = `${JSON.stringify(sessionHeader)}\n${JSON.stringify(usageMessage1)}\n${JSON.stringify(usageMessage2)}\n`;
    writeFileSync(filePath, content);

    // Second scan: should process message2 (which completes the partial line)
    processFile(db, filePath, "session.jsonl", sessionHeader, content, firstScanOffset);

    // Verify message2 was processed
    events = db.query<any, []>("SELECT * FROM usage_events").all();
    expect(events.length).toBe(2); // message1 from first scan + message2 from second scan
    sessions = db.query<any, []>("SELECT * FROM sessions").all();
    expect(sessions[0].message_count).toBe(2);

    db.close();
  });
});
