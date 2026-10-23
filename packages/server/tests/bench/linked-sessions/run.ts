/**
 * Linked-session A/B benchmark: run one variant (a PizzaPi worktree) through
 * the fixed three-level scenario N times against its own sandbox relay and a
 * REAL runner daemon, with a scripted human. Writes raw artifacts per run to
 * <out>/<label>/run-<i>/ for analyze.ts.
 *
 *   bun tests/bench/linked-sessions/run.ts --variant <worktree> --label base --runs 3 --out /tmp/lbench --scenario watchman
 *
 * Env: BENCH_PI_PACKAGES (comma list of pi packages for the temp HOME, e.g. the
 * claude-subscription provider package), CLAUDE_CONFIG_DIR (default ~/.claude).
 *
 * Isolation: temp HOME per run, in-memory Redis, sandbox DB. The only shared
 * resource is the Claude Code credential, read in place via CLAUDE_CONFIG_DIR.
 */
import { io } from "socket.io-client";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync, readdirSync, statSync, openSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const variant = realpathSync(args.variant);
const label = args.label ?? "variant";
const runs = Number(args.runs ?? 1);
const out = args.out ?? "/tmp/lbench";
const ttlMs = Number(args.ttl ?? 90_000);
const runTimeoutMs = Number(args.timeout ?? 30 * 60_000);
const model = { provider: "claude-subscription", id: args.model ?? "claude-sonnet-5-5" };
const scenario = args.scenario ?? "watchman";
const HERE = join(import.meta.dir, "scenarios", scenario);
const PROMPT = readFileSync(join(HERE, "prompt.md"), "utf8");
const LICENSE_ANSWER = "SPDX-License-Identifier: BlueOak-1.0.0";
const HUMAN_DELAY_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)} ${label}]`, ...a);

function humanAnswer(question: string): string {
  if (/licen[cs]e|spdx|header/i.test(question)) return `Use this exact header line: // ${LICENSE_ANSWER}`;
  if (/push|approv|merge/i.test(question)) return "Yes — approved. Push fix/eng-1.";
  return "No preference from me — use your best judgment.";
}

async function waitForLog(file: string, re: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const m = existsSync(file) ? readFileSync(file, "utf8").match(re) : null;
    if (m) return m;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${re} in ${file}`);
}

/** Kill a process and every descendant (children first). */
function killTree(pid: number | undefined) {
  if (!pid) return;
  const kids = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  for (const k of kids) killTree(Number(k));
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}

async function runOnce(i: number) {
  const dir = join(out, label, `run-${i}`);
  mkdirSync(dir, { recursive: true });
  const home = realpathSync(mkdtempSync(`/tmp/lbench-${label}-${i}-`));
  const procs: ChildProcess[] = [];
  const human: Array<Record<string, unknown>> = [];
  const t0 = Date.now();
  try {
    // ── Sandbox relay from the variant's own server code ──────────────────
    const sbxLog = join(dir, "sandbox.log");
    const sbx = spawn("bash", ["-c", `exec bun tests/harness/sandbox.ts --headless --redis=memory > ${sbxLog} 2>&1`], {
      cwd: join(variant, "packages/server"),
      env: { ...process.env, PIZZAPI_SESSION_ID: "", PIZZAPI_API_KEY: "" },
    });
    procs.push(sbx);
    await waitForLog(sbxLog, /Sandbox ready/, 120_000);
    const sbxText = readFileSync(sbxLog, "utf8");
    const server = sbxText.match(/Server:\s+(http:\/\/[\d.:]+)/)![1];
    const api = sbxText.match(/API:\s+(http:\/\/[\d.:]+)/)![1];
    const cred = (await (await fetch(`${api}/credentials`)).json()) as { apiKey: string; email: string; password: string };
    const H = { "x-api-key": cred.apiKey, "content-type": "application/json" };

    // ── Temp HOME + fixture repo ───────────────────────────────────────────
    mkdirSync(join(home, ".pizzapi"), { recursive: true });
    writeFileSync(join(home, ".pizzapi/settings.json"), JSON.stringify({
      defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "low", quietStartup: true,
      packages: process.env.BENCH_PI_PACKAGES ? process.env.BENCH_PI_PACKAGES.split(",") : [],
    }));
    const repo = join(home, "work/fixture");
    cpSync(join(HERE, "fixture"), repo, { recursive: true });
    // Fixture tests are stored as *.test.js.fixture so the repo's own `bun test` skips them.
    spawnSync("bash", ["-c", "find . -name '*.test.js.fixture' | while read f; do mv \"$f\" \"${f%.fixture}\"; done"], { cwd: repo });
    spawnSync("bash", ["-c", "git init -q -b main && git add . && git -c user.email=b@b -c user.name=bench commit -qm init"], { cwd: repo });
    if (existsSync(join(HERE, "setup.sh"))) spawnSync("sh", [join(HERE, "setup.sh")], { cwd: repo });

    // ── Real runner daemon from the variant's CLI ──────────────────────────
    const runnerLog = join(dir, "runner.log");
    const runnerLogFd = openSync(runnerLog, "w");
    const runner = spawn("bun", [join(variant, "packages/cli/src/index.ts"), "runner"], {
      cwd: home,
      env: {
        PATH: process.env.PATH!, HOME: home, TERM: "xterm-256color",
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME!, ".claude"),
        PIZZAPI_RELAY_URL: server.replace(/^http/, "ws"),
        PIZZAPI_RUNNER_API_KEY: cred.apiKey, PIZZAPI_API_KEY: cred.apiKey,
        PIZZAPI_RUNNER_NAME: `bench-${label}-${i}`,
        PIZZAPI_WORKSPACE_ROOTS: join(home, "work"),
        PIZZAPI_RUNNER_STATE_PATH: join(home, "runner-state.json"),
        PIZZAPI_LIFECYCLE_TTL_MS: String(ttlMs),
      },
      stdio: ["ignore", runnerLogFd, runnerLogFd],
    });
    procs.push(runner);
    const runnerId = (await waitForLog(runnerLog, /registered as ([0-9a-f-]{36})/, 60_000))[1];

    // ── Root session ───────────────────────────────────────────────────────
    const spawnRes = (await (await fetch(`${server}/api/runners/spawn`, {
      method: "POST", headers: H, body: JSON.stringify({ runnerId, cwd: repo, model, prompt: PROMPT }),
    })).json()) as { sessionId?: string; error?: string };
    if (!spawnRes.sessionId) throw new Error(`spawn failed: ${spawnRes.error}`);
    const rootId = spawnRes.sessionId;
    log(`run ${i}: root ${rootId.slice(0, 8)}`);

    // ── Scripted human #1: the root's own AskUserQuestion (viewer input) ────
    const signIn = await fetch(`${server}/api/auth/sign-in/email`, {
      method: "POST", headers: { "content-type": "application/json", origin: server },
      body: JSON.stringify({ email: cred.email, password: cred.password }),
    });
    const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const viewer = io(`${server}/viewer`, {
      extraHeaders: { cookie }, query: { sessionId: rootId }, transports: ["websocket"], reconnection: true,
    });
    viewer.on("connect", () => viewer.emit("connected" as any, {}));
    const answeredCalls = new Set<string>();
    viewer.on("event" as any, (data: { event?: any }) => {
      const e = data?.event;
      const isAsk = (e?.type === "tool_execution_start" && e?.toolName === "AskUserQuestion") || e?.type === "question_pending";
      if (!isAsk) return;
      const callId = e.toolCallId ?? e.question?.toolCallId ?? JSON.stringify(e).slice(0, 80);
      if (answeredCalls.has(callId)) return;
      answeredCalls.add(callId);
      const qs = e.args?.questions ?? e.question?.questions ?? [];
      const text = qs.map((q: any) => q.question).join(" ") || String(e.args?.question ?? "");
      const answer = humanAnswer(text);
      human.push({ via: "root_ask", at: Date.now() - t0, ts: new Date(Date.now() + HUMAN_DELAY_MS).toISOString(), question: text, answer });
      setTimeout(() => viewer.emit("input" as any, { text: answer }), HUMAN_DELAY_MS);
    });

    // ── Scripted human #2: questions escalated past the top of the chain ───
    const answeredDeliveries = new Set<string>();
    const pollEscalations = async () => {
      const { events = [] } = (await (await fetch(`${server}/api/events?limit=500`, { headers: H })).json()) as any;
      for (const ev of events) {
        if (!ev.responseContract || !String(ev.type).includes("ask_question")) continue;
        const { deliveries = [] } = (await (await fetch(`${server}/api/events/${ev.eventId}/deliveries`, { headers: H })).json()) as any;
        if (deliveries.some((d: any) => d.status === "responded")) continue;
        const top = deliveries.find((d: any) => d.status === "expired");
        if (!top || answeredDeliveries.has(top.deliveryId)) continue;
        answeredDeliveries.add(top.deliveryId);
        const text = String(ev.payload?.question ?? "");
        const answer = humanAnswer(text);
        human.push({ via: "escalation_push", at: Date.now() - t0, ts: new Date(Date.now() + HUMAN_DELAY_MS).toISOString(), question: text, answer, deliveryId: top.deliveryId });
        setTimeout(() => void fetch(`${server}/api/deliveries/${top.deliveryId}/response`, {
          method: "POST", headers: H, body: JSON.stringify({ response: answer }),
        }), HUMAN_DELAY_MS);
      }
    };

    // ── Done = quiescent: root's last entry is a final assistant reply and no
    // transcript has changed for QUIET_MS (children finished or are parked).
    const QUIET_MS = 150_000;
    const rootDone = () => {
      const sessDir = join(home, ".pizzapi/sessions");
      if (!existsSync(sessDir)) return false;
      let newest = 0;
      let rootFinal = false;
      for (const d of readdirSync(sessDir)) for (const f of readdirSync(join(sessDir, d))) {
        const p = join(sessDir, d, f);
        newest = Math.max(newest, statSync(p).mtimeMs);
        const txt = readFileSync(p, "utf8");
        if (!txt.includes("BENCHMARK TASK")) continue;
        const last = txt.trim().split("\n").at(-1);
        try {
          const m = JSON.parse(last ?? "").message;
          rootFinal = m?.role === "assistant" && m?.stopReason === "stop";
        } catch { /* partial line */ }
      }
      return rootFinal && Date.now() - newest > QUIET_MS;
    };
    let status = "timeout";
    while (Date.now() - t0 < runTimeoutMs) {
      await pollEscalations().catch(() => {});
      if (rootDone()) { status = "done"; break; }
      await sleep(10_000);
    }
    await pollEscalations().catch(() => {});
    viewer.disconnect();

    // ── Collect artifacts ──────────────────────────────────────────────────
    const { events = [] } = (await (await fetch(`${server}/api/events?limit=500`, { headers: H })).json()) as any;
    for (const ev of events) {
      ev.deliveries = ((await (await fetch(`${server}/api/events/${ev.eventId}/deliveries`, { headers: H })).json()) as any).deliveries;
    }
    writeFileSync(join(dir, "events.json"), JSON.stringify(events, null, 1));
    writeFileSync(join(dir, "human.json"), JSON.stringify(human, null, 1));
    const test = spawnSync("bun", ["test"], { cwd: repo, encoding: "utf8", timeout: 60_000 });
    const diff = spawnSync("bash", ["-c", "git add -A && git diff --cached"], { cwd: repo, encoding: "utf8" }).stdout;
    writeFileSync(join(dir, "repo.diff"), diff);
    const remoteBranches = spawnSync("git", ["--git-dir", join(home, "work/remote.git"), "branch", "--format=%(refname:short)"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({
      label, run: i, status, rootId, scenario, remoteBranches, wallMs: Date.now() - t0, ttlMs, model,
      testsPass: test.status === 0, testOutput: (test.stdout + test.stderr).slice(-2000),
    }, null, 1));
    cpSync(join(home, ".pizzapi/sessions"), join(dir, "sessions"), { recursive: true });
    log(`run ${i}: ${status} in ${Math.round((Date.now() - t0) / 60000)}m, tests ${test.status === 0 ? "pass" : "FAIL"}`);
  } finally {
    for (const p of procs.reverse()) killTree(p.pid);
  }
}

for (let i = 1; i <= runs; i++) {
  try { await runOnce(i); } catch (err) { log(`run ${i} failed:`, err); }
}
process.exit(0);
