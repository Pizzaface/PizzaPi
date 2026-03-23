import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { Database } from "bun:sqlite";
import { getUsageData } from "./aggregator.js";
import type { UsageRange } from "./types.js";

function createTestDb(): Database {
  const db = new Database(":memory:");
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

  db.run("CREATE INDEX idx_events_timestamp ON usage_events(timestamp)");
  db.run("CREATE INDEX idx_events_project ON usage_events(project)");
  db.run("CREATE INDEX idx_events_model ON usage_events(model)");
  db.run("CREATE INDEX idx_sessions_started ON sessions(started_at)");
  db.run("CREATE INDEX idx_sessions_project ON sessions(project)");

  return db;
}

describe("Aggregator", () => {
  test("empty database returns zeroed summary", () => {
    const db = createTestDb();
    const data = getUsageData(db, "90d");

    expect(data.summary.totalSessions).toBe(0);
    expect(data.summary.totalCost).toBe(0);
    expect(data.summary.totalInputTokens).toBe(0);
    expect(data.daily).toHaveLength(0);
    expect(data.byModel).toHaveLength(0);
    expect(data.byProject).toHaveLength(0);

    db.close();
  });

  test("daily rollups group by date", () => {
    const db = createTestDb();
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    // Insert events on 3 different days
    const session1StartMs = now - 2 * oneDay;
    const session2StartMs = now - oneDay;
    const session3StartMs = now;

    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "/proj1", null, session1StartMs, session1StartMs + 60000, 1, 100, 50, 0, 0, 0.5, "claude-opus", "anthropic"]
    );

    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "/proj2", null, session2StartMs, session2StartMs + 60000, 1, 200, 100, 0, 0, 1.0, "claude-sonnet", "anthropic"]
    );

    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s3", "/proj1", null, session3StartMs, session3StartMs + 60000, 1, 150, 75, 0, 0, 0.75, "claude-opus", "anthropic"]
    );

    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "/proj1", session1StartMs, "anthropic", "claude-opus", 100, 50, 0, 0, 0.5, 0.3, 0.2, 0, 0]
    );

    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "/proj2", session2StartMs, "anthropic", "claude-sonnet", 200, 100, 0, 0, 1.0, 0.6, 0.4, 0, 0]
    );

    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s3", "/proj1", session3StartMs, "anthropic", "claude-opus", 150, 75, 0, 0, 0.75, 0.45, 0.3, 0, 0]
    );

    const data = getUsageData(db, "all");

    expect(data.daily.length).toBe(3);
    expect(data.daily[0].sessions).toBe(1);
    expect(data.daily[1].sessions).toBe(1);
    expect(data.daily[2].sessions).toBe(1);

    // Verify costs are summed per day
    expect(data.daily[0].cost).toBeCloseTo(0.5, 5);
    expect(data.daily[1].cost).toBeCloseTo(1.0, 5);
    expect(data.daily[2].cost).toBeCloseTo(0.75, 5);

    db.close();
  });

  test("model breakdown shows top models by cost", () => {
    const db = createTestDb();
    const now = Date.now();

    // Insert sessions with different models
    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "/proj1", null, now, now + 60000, 1, 100, 50, 0, 0, 2.0, "claude-opus", "anthropic"]
    );

    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "/proj2", null, now, now + 60000, 1, 200, 100, 0, 0, 1.0, "claude-sonnet", "anthropic"]
    );

    // Insert usage events
    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "/proj1", now, "anthropic", "claude-opus", 100, 50, 0, 0, 2.0, 1.2, 0.8, 0, 0]
    );

    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "/proj2", now, "anthropic", "claude-sonnet", 200, 100, 0, 0, 1.0, 0.6, 0.4, 0, 0]
    );

    const data = getUsageData(db, "all");

    expect(data.byModel.length).toBe(2);
    expect(data.byModel[0].model).toBe("claude-opus");
    expect(data.byModel[0].cost).toBeCloseTo(2.0, 5);
    expect(data.byModel[0].sessions).toBe(1);
    expect(data.byModel[1].model).toBe("claude-sonnet");
    expect(data.byModel[1].cost).toBeCloseTo(1.0, 5);

    db.close();
  });

  test("project breakdown shows top projects", () => {
    const db = createTestDb();
    const now = Date.now();

    // Insert sessions for different projects
    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "/home/user/projects/pizzapi", null, now, now + 60000, 1, 100, 50, 0, 0, 2.0, "claude-opus", "anthropic"]
    );

    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "/home/user/projects/other", null, now, now + 60000, 1, 200, 100, 0, 0, 1.0, "claude-sonnet", "anthropic"]
    );

    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "/home/user/projects/pizzapi", now, "anthropic", "claude-opus", 100, 50, 0, 0, 2.0, 1.2, 0.8, 0, 0]
    );

    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "/home/user/projects/other", now, "anthropic", "claude-sonnet", 200, 100, 0, 0, 1.0, 0.6, 0.4, 0, 0]
    );

    const data = getUsageData(db, "all");

    expect(data.byProject.length).toBe(2);
    expect(data.byProject[0].projectShort).toBe("pizzapi");
    expect(data.byProject[0].cost).toBeCloseTo(2.0, 5);
    expect(data.byProject[1].projectShort).toBe("other");
    expect(data.byProject[1].cost).toBeCloseTo(1.0, 5);

    db.close();
  });

  test("summary excludes null costs", () => {
    const db = createTestDb();
    const now = Date.now();

    // One session with cost, one without
    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "/proj1", null, now, now + 60000, 1, 100, 50, 0, 0, 2.0, "claude-opus", "anthropic"]
    );

    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "/proj2", null, now, now + 60000, 1, 200, 100, 0, 0, null, "claude-sonnet", "anthropic"]
    );

    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "/proj1", now, "anthropic", "claude-opus", 100, 50, 0, 0, 2.0, 1.2, 0.8, 0, 0]
    );

    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "/proj2", now, "anthropic", "claude-sonnet", 200, 100, 0, 0, null, null, null, null, null]
    );

    const data = getUsageData(db, "all");

    expect(data.summary.totalSessions).toBe(2);
    expect(data.summary.sessionsWithCost).toBe(1);
    expect(data.summary.totalCost).toBeCloseTo(2.0, 5);
    expect(data.summary.avgSessionCost).toBeCloseTo(2.0, 5); // Only s1 has cost

    db.close();
  });

  test("avgSessionDurationMs excludes sessions without ended_at", () => {
    const db = createTestDb();
    const now = Date.now();

    // One session with ended_at, one without
    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "/proj1", null, now, now + 60000, 1, 100, 50, 0, 0, 1.0, "claude-opus", "anthropic"]
    );

    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "/proj2", null, now, null, 1, 200, 100, 0, 0, 1.0, "claude-sonnet", "anthropic"]
    );

    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "/proj1", now, "anthropic", "claude-opus", 100, 50, 0, 0, 1.0, 0.6, 0.4, 0, 0]
    );

    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "/proj2", now, "anthropic", "claude-sonnet", 200, 100, 0, 0, 1.0, 0.6, 0.4, 0, 0]
    );

    const data = getUsageData(db, "all");

    expect(data.summary.avgSessionDurationMs).toBe(60000);

    db.close();
  });

  test("date range filtering respects 'all'", () => {
    const db = createTestDb();
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const oldSession = now - 1000 * oneDay; // 1000 days ago

    // Old session
    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "/proj1", null, oldSession, oldSession + 60000, 1, 100, 50, 0, 0, 1.0, "claude-opus", "anthropic"]
    );

    // Recent session
    db.run(
      `INSERT INTO sessions (id, project, session_name, started_at, ended_at, 
       message_count, total_input, total_output, total_cache_read, total_cache_write,
       total_cost, primary_model, primary_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "/proj2", null, now, now + 60000, 1, 200, 100, 0, 0, 1.0, "claude-sonnet", "anthropic"]
    );

    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s1", "/proj1", oldSession, "anthropic", "claude-opus", 100, 50, 0, 0, 1.0, 0.6, 0.4, 0, 0]
    );

    db.run(
      `INSERT INTO usage_events (session_id, project, timestamp, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["s2", "/proj2", now, "anthropic", "claude-sonnet", 200, 100, 0, 0, 1.0, 0.6, 0.4, 0, 0]
    );

    const data = getUsageData(db, "all");

    // "all" should include both old and new sessions
    expect(data.summary.totalSessions).toBe(2);
    expect(data.daily.length).toBe(2); // Both dates should be included

    db.close();
  });
});
