import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openUsageDb } from "./schema.js";
import { processFile, parseSessionHeader, extractSessionName } from "./scanner.js";

function makeDb(tmpDir: string): Database {
  return openUsageDb(join(tmpDir, "test.db"));
}

function usageMsg(id: string, timestamp: string, input: number, output: number, cost = 0.001) {
  return {
    type: "message",
    id,
    timestamp,
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-opus",
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { total: cost, input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0 },
      },
    },
  };
}

const header = (id: string) =>
  ({
    type: "session",
    version: 1,
    id,
    timestamp: "2026-03-23T12:00:00Z",
    cwd: "/project/test",
  }) as const;

describe("Scanner", () => {
  test("parseSessionHeader parses valid session header", () => {
    const line = JSON.stringify(header("session-123"));
    const result = parseSessionHeader(line);
    expect(result).toBeTruthy();
    expect(result?.id).toBe("session-123");
    expect(result?.cwd).toBe("/project/test");
  });

  test("parseSessionHeader returns null for non-session lines", () => {
    expect(parseSessionHeader(JSON.stringify({ type: "message", id: "msg-123" }))).toBeNull();
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
          { tool_call_id: "call-123", name: "set_session_name", arguments: JSON.stringify({ name: "My Test Session" }) },
        ],
      },
    });
    expect(extractSessionName(line)).toBe("My Test Session");
  });

  test("extractSessionName returns null when no session name found", () => {
    const line = JSON.stringify({
      type: "message",
      timestamp: "2026-03-23T12:00:00Z",
      message: { role: "assistant", provider: "anthropic", model: "claude-opus" },
    });
    expect(extractSessionName(line)).toBeNull();
  });

  test("processFile correctly parses JSONL with usage data", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const filePath = join(tmpDir, "session.jsonl");
    const h = header("session-001");
    const msg = usageMsg("msg-001", "2026-03-23T12:05:00Z", 100, 50);
    writeFileSync(filePath, `${JSON.stringify(h)}\n${JSON.stringify(msg)}\n`);

    const db = makeDb(tmpDir);
    processFile(db, filePath, "session.jsonl", h);

    const events = db.query<any, []>("SELECT * FROM usage_events").all();
    expect(events.length).toBe(1);
    expect(events[0].session_id).toBe("session-001");
    expect(events[0].project).toBe("/project/test");
    expect(events[0].model).toBe("claude-opus");
    expect(events[0].input_tokens).toBe(100);
    expect(events[0].output_tokens).toBe(50);
    expect(events[0].cost_usd).toBeCloseTo(0.001, 6);
    expect(events[0].event_uid).toBeTruthy();

    const sessions = db.query<any, []>("SELECT * FROM sessions").all();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe("session-001");
    expect(sessions[0].message_count).toBe(1);
    expect(sessions[0].total_input).toBe(100);
    expect(sessions[0].primary_model).toBe("claude-opus");
    db.close();
  });

  test("processFile includes /goal evaluator spend (goal_evaluator_usage custom entries) in usage totals", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const filePath = join(tmpDir, "session.jsonl");
    const h = header("session-goal");
    const msg = usageMsg("msg-001", "2026-03-23T12:05:00Z", 100, 50, 0.01);
    const evaluatorUsage = {
      type: "custom",
      id: "entry-001",
      customType: "goal_evaluator_usage",
      timestamp: "2026-03-23T12:06:00Z",
      data: {
        provider: "anthropic",
        model: "claude-haiku",
        tokens: 60,
        cost: 0.0002,
        timestamp: new Date("2026-03-23T12:06:00Z").getTime(),
      },
    };
    const content = `${JSON.stringify(h)}\n${JSON.stringify(msg)}\n${JSON.stringify(evaluatorUsage)}\n`;
    writeFileSync(filePath, content);

    const db = makeDb(tmpDir);
    processFile(db, filePath, "session.jsonl", h, content);

    const events = db.query<any, []>("SELECT * FROM usage_events ORDER BY timestamp").all();
    expect(events.length).toBe(2);
    expect(events[1].model).toBe("claude-haiku");
    expect(events[1].output_tokens).toBe(60);
    expect(events[1].cost_usd).toBeCloseTo(0.0002, 6);

    const sessions = db.query<any, []>("SELECT * FROM sessions").all();
    expect(sessions.length).toBe(1);
    expect(sessions[0].total_cost).toBeCloseTo(0.01 + 0.0002, 6);
    expect(sessions[0].total_output).toBe(50 + 60);
    db.close();
  });

  test("processFile skips malformed JSON lines without crashing", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const filePath = join(tmpDir, "session.jsonl");
    const h = header("session-002");
    writeFileSync(filePath, `${JSON.stringify(h)}\nmalformed json line\n`);

    const db = makeDb(tmpDir);
    processFile(db, filePath, "session.jsonl", h);
    expect(db.query<any, []>("SELECT * FROM usage_events").all().length).toBe(0);
    db.close();
  });

  test("processFile handles sessions with no cost data", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const filePath = join(tmpDir, "session.jsonl");
    const h = header("session-003");
    const msg = {
      type: "message",
      id: "msg-001",
      timestamp: "2026-03-23T12:05:00Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus",
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
      },
    };
    writeFileSync(filePath, `${JSON.stringify(h)}\n${JSON.stringify(msg)}\n`);

    const db = makeDb(tmpDir);
    processFile(db, filePath, "session.jsonl", h);
    const events = db.query<any, []>("SELECT * FROM usage_events").all();
    expect(events.length).toBe(1);
    expect(events[0].cost_usd).toBeNull();
    db.close();
  });

  test("processFile handles incremental processing correctly", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const filePath = join(tmpDir, "session.jsonl");
    const h = header("session-004");
    const msg1 = usageMsg("msg-001", "2026-03-23T12:05:00Z", 100, 50, 0.001);
    let content = `${JSON.stringify(h)}\n${JSON.stringify(msg1)}\n`;
    writeFileSync(filePath, content);

    const db = makeDb(tmpDir);
    processFile(db, filePath, "session.jsonl", h, content);

    let sessions = db.query<any, []>("SELECT * FROM sessions").all();
    expect(sessions[0].message_count).toBe(1);
    expect(sessions[0].total_input).toBe(100);

    const firstScanOffset = db
      .query<{ last_offset: number }, []>("SELECT last_offset FROM processing_state")
      .get()!.last_offset;

    const msg2 = usageMsg("msg-002", "2026-03-23T12:10:00Z", 200, 100, 0.002);
    content = `${JSON.stringify(h)}\n${JSON.stringify(msg1)}\n${JSON.stringify(msg2)}\n`;
    writeFileSync(filePath, content);
    processFile(db, filePath, "session.jsonl", h, content, firstScanOffset);

    expect(db.query<any, []>("SELECT * FROM usage_events").all().length).toBe(2);
    sessions = db.query<any, []>("SELECT * FROM sessions").all();
    expect(sessions[0].message_count).toBe(2);
    expect(sessions[0].total_input).toBe(300);
    expect(sessions[0].total_output).toBe(150);
    db.close();
  });

  test("processFile handles partial lines correctly", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const filePath = join(tmpDir, "session.jsonl");
    const h = header("session-005");
    const msg1 = usageMsg("msg-001", "2026-03-23T12:05:00Z", 100, 50, 0.001);
    const msg2 = usageMsg("msg-002", "2026-03-23T12:10:00Z", 200, 100, 0.002);

    // File with one complete message and a partial line (cut mid-JSON, no newline)
    const partialLine = JSON.stringify(msg2).slice(0, 50);
    let content = `${JSON.stringify(h)}\n${JSON.stringify(msg1)}\n${partialLine}`;
    writeFileSync(filePath, content);

    const db = makeDb(tmpDir);
    processFile(db, filePath, "session.jsonl", h, content);

    expect(db.query<any, []>("SELECT * FROM usage_events").all().length).toBe(1);
    expect(db.query<any, []>("SELECT * FROM sessions").all()[0].message_count).toBe(1);

    const firstScanOffset = db
      .query<{ last_offset: number }, []>("SELECT last_offset FROM processing_state")
      .get()!.last_offset;
    // Offset must point exactly at the start of the partial line — i.e. the
    // partial bytes were NOT consumed.
    expect(firstScanOffset).toBe(
      Buffer.byteLength(`${JSON.stringify(h)}\n${JSON.stringify(msg1)}\n`, "utf-8"),
    );

    // Complete the partial line
    content = `${JSON.stringify(h)}\n${JSON.stringify(msg1)}\n${JSON.stringify(msg2)}\n`;
    writeFileSync(filePath, content);
    processFile(db, filePath, "session.jsonl", h, content, firstScanOffset);

    expect(db.query<any, []>("SELECT * FROM usage_events").all().length).toBe(2);
    expect(db.query<any, []>("SELECT * FROM sessions").all()[0].message_count).toBe(2);
    db.close();
  });

  test("replaying the same file does not double-count summaries", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const filePath = join(tmpDir, "session.jsonl");
    const h = header("session-replay");
    const msg1 = usageMsg("msg-001", "2026-03-23T12:05:00Z", 100, 50, 0.001);
    const msg2 = usageMsg("msg-002", "2026-03-23T12:10:00Z", 200, 100, 0.002);
    const content = `${JSON.stringify(h)}\n${JSON.stringify(msg1)}\n${JSON.stringify(msg2)}\n`;
    writeFileSync(filePath, content);

    const db = makeDb(tmpDir);
    processFile(db, filePath, "session.jsonl", h, content);
    // Replay from offset 0 (e.g. lost processing_state row) — events are
    // deduped by event_uid, and summaries must not inflate.
    processFile(db, filePath, "session.jsonl", h, content);
    processFile(db, filePath, "session.jsonl", h, content);

    expect(db.query<any, []>("SELECT * FROM usage_events").all().length).toBe(2);
    const s = db.query<any, []>("SELECT * FROM sessions").all()[0];
    expect(s.message_count).toBe(2);
    expect(s.total_input).toBe(300);
    expect(s.total_output).toBe(150);
    expect(s.total_cost).toBeCloseTo(0.003, 6);
    db.close();
  });

  test("distinct events with identical (session, timestamp, model) are both recorded", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const filePath = join(tmpDir, "session.jsonl");
    const h = header("session-samets");
    // Two distinct API calls in the same millisecond with the same model —
    // the old UNIQUE(session_id, timestamp, model) key silently dropped one.
    const msg1 = usageMsg("msg-001", "2026-03-23T12:05:00Z", 100, 50, 0.001);
    const msg2 = usageMsg("msg-002", "2026-03-23T12:05:00Z", 200, 100, 0.002);
    const content = `${JSON.stringify(h)}\n${JSON.stringify(msg1)}\n${JSON.stringify(msg2)}\n`;
    writeFileSync(filePath, content);

    const db = makeDb(tmpDir);
    processFile(db, filePath, "session.jsonl", h, content);

    expect(db.query<any, []>("SELECT * FROM usage_events").all().length).toBe(2);
    const s = db.query<any, []>("SELECT * FROM sessions").all()[0];
    expect(s.total_input).toBe(300);
    db.close();
  });

  test("malformed complete line stops processing and records its exact byte start", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const filePath = join(tmpDir, "session.jsonl");
    const h = header("session-badline");
    const msg1 = usageMsg("msg-001", "2026-03-23T12:05:00Z", 100, 50, 0.001);
    const msg2 = usageMsg("msg-002", "2026-03-23T12:10:00Z", 200, 100, 0.002);
    const prefix = `${JSON.stringify(h)}\n${JSON.stringify(msg1)}\n`;
    const content = `${prefix}{not json}\n${JSON.stringify(msg2)}\n`;
    writeFileSync(filePath, content);

    const db = makeDb(tmpDir);
    processFile(db, filePath, "session.jsonl", h, content);

    // Only the message before the malformed line was processed; the offset
    // points at the malformed line's byte start, not past msg2.
    expect(db.query<any, []>("SELECT * FROM usage_events").all().length).toBe(1);
    const offset = db
      .query<{ last_offset: number }, []>("SELECT last_offset FROM processing_state")
      .get()!.last_offset;
    expect(offset).toBe(Buffer.byteLength(prefix, "utf-8"));
    db.close();
  });

  test("rebuild replaces obsolete accounting for a truncated/rewritten file", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const filePath = join(tmpDir, "session.jsonl");
    const h = header("session-truncate");
    const msg1 = usageMsg("msg-001", "2026-03-23T12:05:00Z", 100, 50, 0.001);
    const msg2 = usageMsg("msg-002", "2026-03-23T12:10:00Z", 200, 100, 0.002);
    let content = `${JSON.stringify(h)}\n${JSON.stringify(msg1)}\n${JSON.stringify(msg2)}\n`;
    writeFileSync(filePath, content);

    const db = makeDb(tmpDir);
    processFile(db, filePath, "session.jsonl", h, content);
    expect(db.query<any, []>("SELECT * FROM sessions").all()[0].total_input).toBe(300);

    // File rewritten shorter (e.g. trimmed history): only msg1 remains.
    content = `${JSON.stringify(h)}\n${JSON.stringify(msg1)}\n`;
    writeFileSync(filePath, content);
    processFile(db, filePath, "session.jsonl", h, content, undefined, { rebuild: true });

    expect(db.query<any, []>("SELECT * FROM usage_events").all().length).toBe(1);
    const s = db.query<any, []>("SELECT * FROM sessions").all()[0];
    expect(s.total_input).toBe(100);
    expect(s.total_output).toBe(50);
    expect(s.message_count).toBe(1);
    // Offset state reflects the rebuilt (shorter) file
    const offset = db
      .query<{ last_offset: number }, []>("SELECT last_offset FROM processing_state")
      .get()!.last_offset;
    expect(offset).toBe(Buffer.byteLength(content, "utf-8"));
    db.close();
  });

  test("rebuild also purges legacy NULL-uid rows for the session", () => {
    const tmpDir = mkdtempSync("/tmp/usage-scanner-test-");
    const filePath = join(tmpDir, "session.jsonl");
    const h = header("session-legacy");
    const msg1 = usageMsg("msg-001", "2026-03-23T12:05:00Z", 100, 50, 0.001);
    const content = `${JSON.stringify(h)}\n${JSON.stringify(msg1)}\n`;
    writeFileSync(filePath, content);

    const db = makeDb(tmpDir);
    // Simulate a pre-migration row (event_uid NULL) for the same session
    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["session-legacy", "/project/test", 111, "anthropic", "claude-opus", 999, 999],
    );

    processFile(db, filePath, "session.jsonl", h, content, undefined, { rebuild: true });

    const events = db.query<any, []>("SELECT * FROM usage_events").all();
    expect(events.length).toBe(1);
    expect(events[0].input_tokens).toBe(100);
    expect(db.query<any, []>("SELECT * FROM sessions").all()[0].total_input).toBe(100);
    db.close();
  });
});
