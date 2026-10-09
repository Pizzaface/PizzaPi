#!/usr/bin/env bun
/**
 * Production UI slowdown benchmark.
 *
 * Builds or reuses packages/ui/dist, serves it through the real server harness,
 * seeds representative relay traffic, drives the built UI in Playwright, and
 * writes JSON + Markdown results.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { RedisMemoryServer } from "redis-memory-server";
import { createTestServer } from "../tests/harness/server.js";
import { createMockRelay } from "../tests/harness/mock-relay.js";
import { createMockRunner } from "../tests/harness/mock-runner.js";
import { buildAssistantMessage, buildHeartbeat } from "../tests/harness/builders.js";
import { parseSlowdownArgs, renderReport } from "./slowdown-options.js";

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function tinyPngDataUrl(kb: number): string {
  const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lDvlxQAAAABJRU5ErkJggg==";
  return `data:image/png;base64,${png1x1}${"A".repeat(Math.max(0, kb * 1024 - png1x1.length))}`;
}

function messageText(i: number, mediaKb?: number): string {
  const table = "| file | status | notes |\n| --- | --- | --- |\n| src/App.tsx | changed | streaming + session switch path |";
  const base = `History row ${i}\n\n${table}\n\n\`bun test packages/ui/src\` output ${i}`;
  return mediaKb ? `${base}\n\n![${mediaKb}kb png](${tinyPngDataUrl(mediaKb)})` : base;
}

async function run(cmd: string[], cwd = process.cwd()): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`);
}

async function seedSession(server: Awaited<ReturnType<typeof createTestServer>>, count: number, mediaKb?: number) {
  const sessionName = `history-${count}${mediaKb ? `-media-${mediaKb}kb` : ""}`;
  const relay = await createMockRelay(server, { forceNew: true });
  const session = await relay.registerSession({ cwd: process.cwd(), sessionName });
  for (let i = 0; i < count; i++) relay.emitEvent(session.sessionId, session.token, buildAssistantMessage(messageText(i, mediaKb)), i);
  relay.emitEvent(session.sessionId, session.token, buildHeartbeat({ active: false, sessionName }), count + 1);
  return { relay, sessionName, ...session };
}

async function runBrowserMeasurements(baseUrl: string, sessionCookie: string, sessions: Array<{ sessionId: string; sessionName: string }>, outDir: string, headless: boolean) {
  const childOut = join(outDir, "browser-measurements.json");
  const childScript = `
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
const baseUrl = process.env.BENCH_BASE_URL;
const sessionCookie = process.env.BENCH_SESSION_COOKIE;
const sessions = JSON.parse(process.env.BENCH_SESSIONS || "[]");
const out = process.env.BENCH_OUT;
const headless = process.env.BENCH_HEADLESS !== "0";
function addAuthCookie(page) {
  const [pair] = sessionCookie.split(";");
  const [name, ...rest] = pair.split("=");
  return page.context().addCookies([{ name, value: rest.join("="), url: baseUrl, httpOnly: true, sameSite: "Lax" }]);
}
async function measureOpen(page, sessionId) {
  const start = performance.now();
  await page.goto(\`${baseUrl}/session/\${encodeURIComponent(sessionId)}\`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("textarea", { timeout: 120000 });
  await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
  return Math.round(performance.now() - start);
}
// Switches the way a real user does: the same "pp-navigate-session" CustomEvent App.tsx
// listens for (used today by notification-tap navigation), then waits for a signal that
// is specific to the TARGET session — its name rendered in the session header — not a
// fixed sleep. This fails loudly (timeout) if the switch never actually lands.
async function measureSwitch(page, sessionId, sessionName) {
  const start = performance.now();
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent("pp-navigate-session", { detail: { sessionId: id } })), sessionId);
  await page.locator("#main-content").getByText(sessionName, { exact: true }).waitFor({ timeout: 120000 });
  return Math.round(performance.now() - start);
}
const browser = await chromium.launch({ headless });
try {
  const page = await browser.newPage();
  await addAuthCookie(page);
  await page.addInitScript(() => {
    new PerformanceObserver((list) => {
      const prev = window.__pizzapiLongTasks || [];
      window.__pizzapiLongTasks = prev.concat(list.getEntries().map((entry) => entry.duration));
    }).observe({ type: "longtask", buffered: true });
  });
  const openMs = {};
  for (const s of sessions) openMs[s.sessionId] = await measureOpen(page, s.sessionId);
  const switchMs = [];
  for (const s of sessions) switchMs.push(await measureSwitch(page, s.sessionId, s.sessionName));
  const longTasks = await page.evaluate(() => window.__pizzapiLongTasks || []);
  writeFileSync(out, JSON.stringify({ openMs, switchMs, longTasks }, null, 2));
} finally {
  await browser.close().catch(() => {});
}
`;
  const proc = Bun.spawn(["bun", "--eval", childScript], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      BENCH_BASE_URL: baseUrl,
      BENCH_SESSION_COOKIE: sessionCookie,
      BENCH_SESSIONS: JSON.stringify(sessions),
      BENCH_OUT: childOut,
      BENCH_HEADLESS: headless ? "1" : "0",
    },
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`browser benchmark exited ${code}`);
  return JSON.parse(readFileSync(childOut, "utf8")) as { openMs: Record<string, number>; switchMs: number[]; longTasks: number[] };
}

async function main() {
  const opts = parseSlowdownArgs(process.argv.slice(2));
  mkdirSync(opts.outDir, { recursive: true });
  if (opts.buildUi) await run(["bun", "run", "build:ui"]);
  if (!existsSync(join(opts.uiDir, "index.html"))) throw new Error(`Production UI missing at ${opts.uiDir}. Run with --build-ui or pass --ui-dir.`);

  const redis = await RedisMemoryServer.create({ instance: { ip: "127.0.0.1", port: 0 }, autoStart: true } as any);
  process.env.PIZZAPI_REDIS_URL = `redis://${await redis.getHost()}:${await redis.getPort()}`;
  process.env.PIZZAPI_UI_DIR = opts.uiDir;

  const server = await createTestServer({ disableSignupAfterFirstUser: false });
  // ponytail: heterogeneous bag — seedSession() results nest their relay under `.relay`, burst relays are the
  // relay object itself; every read site already normalizes via `(r as any)`, so keep the array untyped rather
  // than fight a union that buys nothing here.
  const relays: any[] = [];
  const runners: Array<{ disconnect(): Promise<void> }> = [];
  try {
    for (let i = 0; i < opts.burstRunners; i++) {
      runners.push(await createMockRunner(server, { name: `benchmark-runner-${i}`, roots: [process.cwd()], serviceIds: ["terminal", "file-explorer", "git"] }));
    }
    const sessions = [] as Array<{ sessionId: string; token: string; sessionName: string }>;
    for (const history of opts.histories) {
      const seeded = await seedSession(server, history);
      relays.push(seeded);
      sessions.push(seeded);
    }
    for (const kb of opts.mediaKb) {
      const seeded = await seedSession(server, 25, kb);
      relays.push(seeded);
      sessions.push(seeded);
    }

    const browserMetrics = await runBrowserMeasurements(server.baseUrl, server.sessionCookie, sessions.map((s) => ({ sessionId: s.sessionId, sessionName: s.sessionName })), opts.outDir, opts.headless);
    console.log(`Measured ${Object.keys(browserMetrics.openMs).length} open paths and ${browserMetrics.switchMs.length} session switches`);

    const burstRelays = [] as Awaited<ReturnType<typeof createMockRelay>>[];
    // Fire-and-forget: this only proves the relay/server accepted the emit, not that a
    // viewer rendered it, so the metric is named "emitted" rather than "delivered".
    let emitted = 0;
    for (let i = 0; i < opts.burstSessions; i++) {
      const relay = await createMockRelay(server, { forceNew: true });
      burstRelays.push(relay);
      const session = await relay.registerSession({ cwd: process.cwd(), sessionName: `burst-${i}` });
      relay.emitEvent(session.sessionId, session.token, buildAssistantMessage(`burst ${i}`), 0);
      emitted++;
    }
    for (const relay of burstRelays) relays.push(relay);
    console.log(`Emitted ${emitted} burst sessions`);

    const soakEnd = Date.now() + opts.soakMs;
    let soakEvents = 0;
    while (Date.now() < soakEnd) {
      const target = sessions[soakEvents % sessions.length]!;
      const relay = relays.find((r: any) => r.sessionId === target.sessionId) as any;
      relay.emitEvent(target.sessionId, target.token, buildAssistantMessage(`soak ${soakEvents}`), 10_000 + soakEvents);
      soakEvents++;
      await Bun.sleep(1000);
    }

    console.log(`Delivered ${soakEvents} soak events`);
    const result = {
      at: new Date().toISOString(),
      uiDir: opts.uiDir,
      histories: opts.histories,
      mediaKb: opts.mediaKb,
      openMs: browserMetrics.openMs,
      switchMs: { samples: browserMetrics.switchMs, median: percentile(browserMetrics.switchMs, 50), p95: percentile(browserMetrics.switchMs, 95), max: Math.max(...browserMetrics.switchMs) },
      burst: { runners: opts.burstRunners, sessions: opts.burstSessions, emitted },
      soak: { durationMs: opts.soakMs, events: soakEvents },
      longTasks: { count: browserMetrics.longTasks.length, maxMs: Math.round(Math.max(0, ...browserMetrics.longTasks)) },
    };
    writeFileSync(join(opts.outDir, "slowdown-results.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(opts.outDir, "slowdown-results.md"), renderReport(result));
    console.log(`Wrote ${join(opts.outDir, "slowdown-results.md")}`);
  } finally {
    for (const relay of relays) {
      const client = (relay as any).disconnect ? relay : (relay as any).relay;
      await client?.disconnect?.().catch(() => {});
    }
    for (const runner of runners) await runner.disconnect().catch(() => {});
    await server.cleanup().catch(() => {});
    await redis.stop().catch(() => {});
  }
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (err) {
    console.error("Benchmark failed:", err);
    process.exit(1);
  }
}
