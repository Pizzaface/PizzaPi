import { describe, expect, test } from "bun:test";
import { parseSlowdownArgs, renderReport } from "../../benchmarks/slowdown-options.js";

describe("slowdown benchmark", () => {
  test("parses smoke-run options and renders the report contract", () => {
    const opts = parseSlowdownArgs([
      "--histories=5,10",
      "--media-kb=65",
      "--burst-runners=1",
      "--burst-sessions=2",
      "--soak-ms=1000",
      "--out=/tmp/pizzapi-slowdown-smoke",
      "--ui-dir=/tmp/ui-dist",
      "--headed",
    ]);

    expect(opts.histories).toEqual([5, 10]);
    expect(opts.mediaKb).toEqual([65]);
    expect(opts.burstRunners).toBe(1);
    expect(opts.burstSessions).toBe(2);
    expect(opts.soakMs).toBe(1000);
    expect(opts.outDir).toBe("/tmp/pizzapi-slowdown-smoke");
    expect(opts.uiDir).toBe("/tmp/ui-dist");
    expect(opts.headless).toBe(false);

    const report = renderReport({
      at: "2026-10-08T00:00:00.000Z",
      uiDir: "/tmp/ui-dist",
      histories: [5, 10],
      mediaKb: [65],
      switchMs: { median: 12, p95: 20, max: 25 },
      burst: { emitted: 2, sessions: 2 },
      soak: { events: 1 },
      longTasks: { maxMs: 0 },
    });

    expect(report).toContain("Session UI slowdown benchmark results");
    expect(report).toContain("Burst sessions emitted | 2/2");
    expect(report).toContain("Raw JSON: `slowdown-results.json`");
  });
});
