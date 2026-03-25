#!/usr/bin/env bun
/**
 * 🍕 PizzaPi Sandbox — local dev playground
 *
 * Spins up a fully functional PizzaPi server with mock sessions so you can
 * test UI/server changes without deploying or running the full stack.
 *
 * Usage:
 *   cd packages/server && bun run sandbox
 *   # or directly:
 *   bun tests/harness/sandbox.ts
 *
 * Opens a real PizzaPi server on an ephemeral port, pre-populates it with
 * mock sessions streaming realistic data, and drops you into a REPL where
 * you can inject more events and watch them appear live in the browser.
 */

import { TestScenario, type ScenarioSession } from "./scenario.js";
import { createMockRunner, type MockRunner } from "./mock-runner.js";
import {
    buildHeartbeat,
    buildAssistantMessage,
    buildToolUseEvent,
    buildToolResultEvent,
    type ConversationTurn,
} from "./builders.js";
import { startSandboxApi, type SandboxApi } from "./sandbox-api.js";
import { addTrustedOrigin } from "../../src/auth.js";
import { RedisMemoryServer } from "redis-memory-server";

// ── Suppress noisy server logs so the REPL stays clean ───────────────────────
// Keep errors but hide connection/disconnect/startup spam.
// Must be installed before any imports trigger server-side logging.
const _origLog = console.log;
const SUPPRESSED = [
    "[sio/relay]",
    "[sio/hub]",
    // "[sio/viewer]",  // temporarily unsuppressed for service_announce debugging
    "[sio/runners]",
    "[sio/runner]",
    "[sio-state]",
    "[startup]",
    "[static]",
    "[push]",
    "Relay Redis cache",
];
console.log = (...args: unknown[]) => {
    const first = String(args[0] ?? "");
    if (SUPPRESSED.some((s) => first.includes(s))) return;
    _origLog(...args);
};

const _origError = console.error;
const SUPPRESSED_ERRORS = [
    "[Better Auth]",
    "[sio/",
    "Relay Redis",
];
console.error = (...args: unknown[]) => {
    const first = String(args[0] ?? "");
    if (SUPPRESSED_ERRORS.some((s) => first.includes(s))) return;
    _origError(...args);
};

// ── Pre-built conversation scenarios ─────────────────────────────────────────

function codeReviewConversation(): unknown[] {
    const events: unknown[] = [];
    let seq = 0;
    const toolId = (n: number) => `tool_${n}_${Date.now()}`;

    // Assistant: opening message
    events.push(buildAssistantMessage(
        "I'll review the authentication module for security issues. Let me start by reading the main auth file.",
    ));

    // Tool: Read src/auth.ts
    const readId = toolId(1);
    events.push({
        type: "message_update",
        role: "assistant",
        content: [buildToolUseEvent("Read", { path: "src/auth.ts" }, readId)],
        messageId: `msg_${Date.now()}_1`,
    });
    events.push({
        type: "tool_result_message",
        content: [buildToolResultEvent(readId, `import { betterAuth } from "better-auth";
import { Database } from "bun:sqlite";

export function initAuth(config: AuthConfig) {
    const db = new Database(config.dbPath);
    return betterAuth({
        database: db,
        emailAndPassword: { enabled: true },
        session: { expiresIn: 60 * 60 * 24 * 7 },
        rateLimit: { window: 60, max: 10 },
    });
}`)],
    });

    // Assistant: analysis
    events.push(buildAssistantMessage(
        "The auth module looks solid overall. I notice a few things:\n\n1. ✅ Rate limiting is enabled (10 req/min)\n2. ✅ Session expiry is set to 7 days\n3. ⚠️ No CSRF protection configured\n4. ⚠️ Missing `trustedOrigins` — this could allow cross-origin attacks\n\nLet me check if CSRF is handled elsewhere...",
    ));

    // Tool: grep for CSRF
    const grepId = toolId(2);
    events.push({
        type: "message_update",
        role: "assistant",
        content: [buildToolUseEvent("Bash", { command: "rg -n 'csrf|CSRF|trustedOrigins' src/" }, grepId)],
        messageId: `msg_${Date.now()}_2`,
    });
    events.push({
        type: "tool_result_message",
        content: [buildToolResultEvent(grepId, `src/middleware.ts:12:  // CSRF check for mutations
src/middleware.ts:15:  if (!trustedOrigins.includes(origin)) {
src/config.ts:8:    trustedOrigins: ["http://localhost:5173"],`)],
    });

    // Assistant: conclusion
    events.push(buildAssistantMessage(
        "Good news — CSRF protection is handled in the middleware layer at `src/middleware.ts:12`. The `trustedOrigins` are configured in `src/config.ts`.\n\n### Summary\n\n| Check | Status |\n|-------|--------|\n| Rate limiting | ✅ Configured |\n| Session expiry | ✅ 7 days |\n| CSRF protection | ✅ In middleware |\n| Trusted origins | ✅ Configured |\n| Password hashing | ✅ better-auth default (argon2) |\n\nThe auth module looks secure. No P0-P2 issues found. **LGTM** 🎉",
    ));

    return events;
}

function toolHeavyConversation(): unknown[] {
    const events: unknown[] = [];
    const toolId = (n: number) => `tool_heavy_${n}_${Date.now()}`;

    events.push(buildAssistantMessage(
        "I'll set up the new feature branch and implement the dark mode toggle. Let me start by creating the branch.",
    ));

    // Bash: git checkout
    const gitId = toolId(1);
    events.push({
        type: "message_update",
        role: "assistant",
        content: [buildToolUseEvent("Bash", { command: "git checkout -b feat/dark-mode-toggle" }, gitId)],
        messageId: `msg_heavy_1`,
    });
    events.push({
        type: "tool_result_message",
        content: [buildToolResultEvent(gitId, "Switched to a new branch 'feat/dark-mode-toggle'")],
    });

    // Write the component
    const writeId = toolId(2);
    events.push({
        type: "message_update",
        role: "assistant",
        content: [buildToolUseEvent("Write", {
            path: "src/components/ThemeToggle.tsx",
            content: "export function ThemeToggle() { ... }",
        }, writeId)],
        messageId: `msg_heavy_2`,
    });
    events.push({
        type: "tool_result_message",
        content: [buildToolResultEvent(writeId, "✅ Wrote 42 lines to src/components/ThemeToggle.tsx")],
    });

    // Read the CSS
    const readCss = toolId(3);
    events.push({
        type: "message_update",
        role: "assistant",
        content: [buildToolUseEvent("Read", { path: "src/style.css" }, readCss)],
        messageId: `msg_heavy_3`,
    });
    events.push({
        type: "tool_result_message",
        content: [buildToolResultEvent(readCss, `:root {
  --bg-primary: #ffffff;
  --text-primary: #1a1a1a;
  --accent: #3b82f6;
}

.dark {
  --bg-primary: #0a0a0a;
  --text-primary: #f5f5f5;
  --accent: #60a5fa;
}`)],
    });

    // Edit the CSS
    const editId = toolId(4);
    events.push({
        type: "message_update",
        role: "assistant",
        content: [buildToolUseEvent("Edit", {
            path: "src/style.css",
            oldText: "--accent: #60a5fa;",
            newText: "--accent: #60a5fa;\n  --border: #2a2a2a;\n  --surface: #141414;",
        }, editId)],
        messageId: `msg_heavy_4`,
    });
    events.push({
        type: "tool_result_message",
        content: [buildToolResultEvent(editId, "✅ Edited src/style.css (1 replacement)")],
    });

    // Run tests
    const testId = toolId(5);
    events.push({
        type: "message_update",
        role: "assistant",
        content: [buildToolUseEvent("Bash", { command: "bun test src/components/ThemeToggle.test.tsx" }, testId)],
        messageId: `msg_heavy_5`,
    });
    events.push({
        type: "tool_result_message",
        content: [buildToolResultEvent(testId, `bun test v1.2.1

src/components/ThemeToggle.test.tsx:
✓ renders toggle button (3ms)
✓ toggles dark class on click (5ms)  
✓ persists preference to localStorage (2ms)
✓ respects prefers-color-scheme (4ms)

 4 pass
 0 fail
Ran 4 tests in 14ms`)],
    });

    events.push(buildAssistantMessage(
        "Dark mode toggle is implemented and all tests pass! Here's what I did:\n\n1. Created `ThemeToggle.tsx` component with system preference detection\n2. Added CSS custom properties for dark theme surfaces and borders\n3. All 4 tests passing ✅\n\nReady for review whenever you are.",
    ));

    return events;
}

function subagentConversation(): unknown[] {
    const events: unknown[] = [];
    const toolId = (n: number) => `tool_sub_${n}_${Date.now()}`;

    events.push(buildAssistantMessage(
        "I need to review the PR changes and run the test suite. Let me spawn a subagent for the code review while I handle the tests.",
    ));

    // Spawn session tool call
    const spawnId = toolId(1);
    events.push({
        type: "message_update",
        role: "assistant",
        content: [buildToolUseEvent("spawn_session", {
            prompt: "Review the changes on branch feat/auth-refactor for P0-P2 bugs.",
            model: { provider: "anthropic", id: "claude-haiku-4-5" },
        }, spawnId)],
        messageId: `msg_sub_1`,
    });
    events.push({
        type: "tool_result_message",
        content: [buildToolResultEvent(spawnId, `Session spawned successfully.
  Session ID: abc-123-def
  Model: anthropic/claude-haiku-4-5
  Status: Ready`)],
    });

    events.push(buildAssistantMessage(
        "Reviewer spawned. While it works, let me run the test suite...",
    ));

    // Run tests
    const testId = toolId(2);
    events.push({
        type: "message_update",
        role: "assistant",
        content: [buildToolUseEvent("Bash", { command: "bun test" }, testId)],
        messageId: `msg_sub_2`,
    });
    events.push({
        type: "tool_result_message",
        content: [buildToolResultEvent(testId, ` 142 pass\n 0 fail\n 389 expect() calls\nRan 142 tests across 18 files. [2.34s]`)],
    });

    events.push(buildAssistantMessage(
        "All 142 tests pass. The reviewer session has completed — it found no P0-P2 bugs.\n\n✅ **Review passed. LGTM.**\n\nReady to merge when you are.",
    ));

    return events;
}

const SCENARIOS: Record<string, { name: string; builder: () => unknown[] }> = {
    review: { name: "Code Review", builder: codeReviewConversation },
    tools: { name: "Tool-Heavy (Dark Mode)", builder: toolHeavyConversation },
    subagent: { name: "Subagent Spawn", builder: subagentConversation },
};

// ── Models pool ──────────────────────────────────────────────────────────────

const MODELS = [
    { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000 },
    { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 200_000 },
    { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000 },
    { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4", contextWindow: 128_000 },
    { provider: "openai-codex", id: "gpt-5.3-codex", name: "GPT-5.3 Codex", contextWindow: 128_000 },
    { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1_000_000 },
];

const SESSION_NAMES = [
    "refactor-auth-module",
    "fix-dark-mode-css",
    "add-webhook-support",
    "migrate-to-bun",
    "review-loop-codex",
    "implement-sse-streaming",
    "fix-race-condition",
    "update-dependencies",
];

const CWDS = [
    "/Users/jordan/Projects/cool-app",
    "/Users/jordan/Projects/secret-project",
    "/Users/jordan/Documents/Projects/PizzaPi",
    "/home/dev/my-api",
    "/Users/jordan/Projects/design-system",
];

let sessionCounter = 0;
let runnerCounter = 0;
const runners: MockRunner[] = [];

function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

// ── Main ─────────────────────────────────────────────────────────────────────

type SandboxRedisMode = "memory" | "docker" | "env";

type SandboxCliOptions = {
    requestedPort: number;
    headless: boolean;
    redisMode: SandboxRedisMode;
};

export function parseCliOptions(argv: string[]): SandboxCliOptions {
    const portArg = argv.find((a) => /^\d+$/.test(a));
    const requestedPort = portArg ? parseInt(portArg, 10) : 0;
    const headless = argv.includes("--headless");
    const redisFlag = argv.find((a) => a.startsWith("--redis="));
    const redisMode = (redisFlag?.slice("--redis=".length) ?? "memory") as SandboxRedisMode;
    if (!["memory", "docker", "env"].includes(redisMode)) {
        throw new Error(`Invalid --redis mode: ${redisMode}. Use memory, docker, or env.`);
    }
    return { requestedPort, headless, redisMode };
}

async function waitForRedis(redisUrl: string, timeoutMs = 10_000): Promise<void> {
    const { createClient } = await import("redis");
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const probe = createClient({ url: redisUrl });
            await probe.connect();
            await probe.ping();
            await probe.quit();
            return;
        } catch {
            await Bun.sleep(250);
        }
    }
    throw new Error(`Redis did not become ready at ${redisUrl} within ${timeoutMs}ms`);
}

async function startRedis(mode: SandboxRedisMode): Promise<(() => Promise<void> | void)> {
    const previousRedisUrl = process.env.PIZZAPI_REDIS_URL;

    if (mode === "env") {
        const existingUrl = process.env.PIZZAPI_REDIS_URL;
        if (!existingUrl) {
            throw new Error("--redis=env requires PIZZAPI_REDIS_URL to be set");
        }
        await waitForRedis(existingUrl);
        console.log(`  🟥 Using existing Redis at ${existingUrl}\n`);
        return () => {};
    }

    if (mode === "memory") {
        const memoryRedis = await RedisMemoryServer.create({
            instance: {
                ip: "127.0.0.1",
                port: await getFreePort(),
            },
            autoStart: true,
        } as any);
        const host = await memoryRedis.getHost();
        const port = await memoryRedis.getPort();
        const redisUrl = `redis://${host}:${port}`;
        process.env.PIZZAPI_REDIS_URL = redisUrl;
        await waitForRedis(redisUrl, 20_000);
        console.log(`  🟥 In-memory Redis ready at ${redisUrl}\n`);
        return async () => {
            await memoryRedis.stop();
            if (previousRedisUrl === undefined) delete process.env.PIZZAPI_REDIS_URL;
            else process.env.PIZZAPI_REDIS_URL = previousRedisUrl;
        };
    }

    // docker mode
    const dockerCheck = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
    if (dockerCheck.exitCode !== 0) {
        throw new Error(
            "Redis is required but Docker is not available.\n" +
            "Either:\n" +
            "  • Use the default --redis=memory mode, or\n" +
            "  • Install and start Docker, or\n" +
            "  • Use --redis=env with an explicit sandbox Redis URL\n",
        );
    }

    const port = await getFreePort();
    const redisUrl = `redis://127.0.0.1:${port}`;
    const containerName = `pizzapi-sandbox-redis-${port}`;

    const proc = Bun.spawn(
        ["docker", "run", "--rm", "-p", `${port}:6379`, "--name", containerName, "redis:alpine"],
        { stdout: "ignore", stderr: "ignore" },
    );

    process.env.PIZZAPI_REDIS_URL = redisUrl;
    try {
        await waitForRedis(redisUrl);
    } catch (err) {
        proc.kill();
        Bun.spawnSync(["docker", "rm", "-f", containerName], { stdout: "ignore", stderr: "ignore" });
        if (previousRedisUrl === undefined) delete process.env.PIZZAPI_REDIS_URL;
        else process.env.PIZZAPI_REDIS_URL = previousRedisUrl;
        throw err;
    }

    console.log(`  🟥 Docker Redis ready at ${redisUrl}\n`);
    return () => {
        proc.kill();
        Bun.spawnSync(["docker", "rm", "-f", containerName], { stdout: "ignore", stderr: "ignore" });
        if (previousRedisUrl === undefined) delete process.env.PIZZAPI_REDIS_URL;
        else process.env.PIZZAPI_REDIS_URL = previousRedisUrl;
    };
}

async function getFreePort(): Promise<number> {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
    const port = server.port;
    server.stop(true);
    return port;
}

// ── Mock system monitor panel server ─────────────────────────────────────────

import { cpus, freemem, totalmem, loadavg } from "node:os";

function startMockSystemMonitor(): { port: number; stop: () => void } {
    // Generate synthetic but realistic-looking stats
    function mockStats() {
        const cores = cpus();
        const numCpus = cores.length;
        const load = loadavg();
        const total = totalmem();
        const free = freemem();
        const used = total - free;

        return {
            timestamp: Date.now(),
            cpu: {
                loadAvg1: Math.round((load[0] / numCpus) * 100) / 100,
                loadAvg5: Math.round((load[1] / numCpus) * 100) / 100,
                loadAvg15: Math.round((load[2] / numCpus) * 100) / 100,
                cores: numCpus,
                overallPct: Math.round(20 + Math.random() * 40),
                perCore: Array.from({ length: numCpus }, () => Math.round(5 + Math.random() * 60)),
            },
            mem: {
                totalMb: Math.round(total / 1024 / 1024),
                usedMb: Math.round(used / 1024 / 1024),
                freeMb: Math.round(free / 1024 / 1024),
                usedPct: Math.round((used / total) * 100),
            },
            disk: {
                path: "/",
                totalGb: 494.4,
                usedGb: Math.round((280 + Math.random() * 20) * 10) / 10,
                availableGb: Math.round((200 - Math.random() * 20) * 10) / 10,
                usedPct: Math.round(56 + Math.random() * 5),
            },
            net: { interfaces: ["en0", "en1"] },
            processes: [
                { pid: 1234, cpu: +(12 + Math.random() * 8).toFixed(1), mem: 4.2, command: "/usr/bin/node" },
                { pid: 5678, cpu: +(8 + Math.random() * 5).toFixed(1), mem: 3.1, command: "/opt/homebrew/bin/bun" },
                { pid: 9012, cpu: +(3 + Math.random() * 4).toFixed(1), mem: 2.8, command: "/Applications/Safari.app/Contents/MacOS/Safari" },
                { pid: 3456, cpu: +(2 + Math.random() * 3).toFixed(1), mem: 1.9, command: "/usr/sbin/WindowServer" },
                { pid: 7890, cpu: +(1 + Math.random() * 2).toFixed(1), mem: 1.2, command: "/usr/libexec/rapportd" },
            ],
        };
    }

    const PANEL_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>System Monitor</title><style>
:root{--bg:#0a0a0b;--bg-card:#131316;--border:#27272a;--text:#e4e4e7;--text-muted:#71717a;--green:#22c55e;--yellow:#eab308;--red:#ef4444}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:11px;overflow-y:auto;height:100vh}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;padding:8px}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:8px 10px}
.card-title{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px}
.metric{display:flex;justify-content:space-between;align-items:center;margin-bottom:3px}
.metric-label{color:var(--text-muted)}.metric-value{font-weight:600;font-variant-numeric:tabular-nums}
.bar-track{width:100%;height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-top:3px}
.bar-fill{height:100%;border-radius:3px;transition:width .5s ease}
.bar-fill.green{background:var(--green)}.bar-fill.yellow{background:var(--yellow)}.bar-fill.red{background:var(--red)}
.core-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(28px,1fr));gap:3px;margin-top:4px}
.core-bar{height:24px;background:var(--border);border-radius:3px;position:relative;overflow:hidden}
.core-bar-fill{position:absolute;bottom:0;width:100%;border-radius:3px;transition:height .5s ease}
.core-bar-label{position:absolute;top:1px;left:0;right:0;text-align:center;font-size:8px;color:var(--text-muted);z-index:1}
.proc-table{width:100%;border-collapse:collapse}
.proc-table th{text-align:left;font-size:9px;font-weight:600;color:var(--text-muted);padding:2px 4px;border-bottom:1px solid var(--border)}
.proc-table td{padding:2px 4px;font-size:10px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}
.status{font-size:9px;color:var(--text-muted);padding:4px 8px;text-align:right}
.loading{display:flex;align-items:center;justify-content:center;height:100vh;color:var(--text-muted)}
</style></head><body>
<div id="app" class="loading">Connecting…</div>
<script>
(function(){
  function bc(p){return p>90?'red':p>70?'yellow':'green'}
  function fm(m){return m>=1024?(m/1024).toFixed(1)+' GB':m+' MB'}
  function render(d){
    var c=d.cpu,m=d.mem,dk=d.disk,pr=d.processes,a=document.getElementById('app');
    a.className='';var h='<div class="grid">';
    h+='<div class="card"><div class="card-title">CPU</div>';
    h+='<div class="metric"><span class="metric-label">Usage</span><span class="metric-value">'+c.overallPct+'%</span></div>';
    h+='<div class="bar-track"><div class="bar-fill '+bc(c.overallPct)+'" style="width:'+c.overallPct+'%"></div></div>';
    h+='<div class="metric" style="margin-top:4px"><span class="metric-label">Load</span><span class="metric-value">'+c.loadAvg1+' / '+c.loadAvg5+' / '+c.loadAvg15+'</span></div>';
    if(c.perCore&&c.perCore.length>0){h+='<div class="core-grid">';c.perCore.forEach(function(p,i){h+='<div class="core-bar"><div class="core-bar-label">'+i+'</div><div class="core-bar-fill '+bc(p)+'" style="height:'+Math.max(p,2)+'%"></div></div>'});h+='</div>'}
    h+='</div>';
    h+='<div class="card"><div class="card-title">Memory</div>';
    h+='<div class="metric"><span class="metric-label">Used</span><span class="metric-value">'+fm(m.usedMb)+' / '+fm(m.totalMb)+'</span></div>';
    h+='<div class="bar-track"><div class="bar-fill '+bc(m.usedPct)+'" style="width:'+m.usedPct+'%"></div></div>';
    h+='<div class="metric" style="margin-top:4px"><span class="metric-label">Free</span><span class="metric-value">'+fm(m.freeMb)+'</span></div></div>';
    if(dk){h+='<div class="card"><div class="card-title">Disk /</div>';
    h+='<div class="metric"><span class="metric-label">Used</span><span class="metric-value">'+dk.usedGb+' / '+dk.totalGb+' GB</span></div>';
    h+='<div class="bar-track"><div class="bar-fill '+bc(dk.usedPct)+'" style="width:'+dk.usedPct+'%"></div></div>';
    h+='<div class="metric" style="margin-top:4px"><span class="metric-label">Available</span><span class="metric-value">'+dk.availableGb+' GB</span></div></div>'}
    h+='</div>';
    if(pr&&pr.length>0){h+='<div style="padding:0 8px 8px"><div class="card"><div class="card-title">Top Processes</div><table class="proc-table"><thead><tr><th>PID</th><th>CPU%</th><th>MEM%</th><th>Command</th></tr></thead><tbody>';
    pr.slice(0,8).forEach(function(p){var cmd=p.command.split('/').pop()||p.command;h+='<tr><td>'+p.pid+'</td><td>'+p.cpu+'</td><td>'+p.mem+'</td><td title="'+p.command+'">'+cmd+'</td></tr>'});
    h+='</tbody></table></div></div>'}
    h+='<div class="status">Updated '+new Date(d.timestamp).toLocaleTimeString()+'</div>';
    a.innerHTML=h;
  }
  async function poll(){try{var r=await fetch('./api/stats');if(r.ok)render(await r.json())}catch(e){}}
  poll();setInterval(poll,3000);
})();
</script></body></html>`;

    const server = Bun.serve({
        port: 0,
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/api/stats" || url.pathname.endsWith("/api/stats")) {
                return new Response(JSON.stringify(mockStats()), {
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                });
            }
            return new Response(PANEL_HTML, {
                headers: { "Content-Type": "text/html; charset=utf-8" },
            });
        },
    });

    return { port: server.port!, stop: () => server.stop(true) };
}

async function main() {
    const opts = parseCliOptions(process.argv.slice(2));

    console.log("\n🍕 PizzaPi Sandbox\n");
    console.log(`Starting server... (${opts.headless ? "headless" : "interactive"}, redis=${opts.redisMode})\n`);

    const stopRedis = await startRedis(opts.redisMode);

    const scenario = new TestScenario();

    // Set PIZZAPI_BASE_URL before server init so share URLs work.
    // We'll update it once we know the actual port.
    const savedBaseUrl = process.env.PIZZAPI_BASE_URL;

    await scenario.setup({
        disableSignupAfterFirstUser: false,
        port: opts.requestedPort,
    });
    const server = scenario.server;

    // NOW set the base URL to the actual server address
    process.env.PIZZAPI_BASE_URL = server.baseUrl;

    console.log("┌─────────────────────────────────────────────────────────────┐");
    console.log(`│  🌐 Server:   ${server.baseUrl.padEnd(44)} │`);
    console.log(`│  📧 Email:    ${server.userEmail.padEnd(44)} │`);
    console.log(`│  🔑 Password: ${"HarnessPass123".padEnd(44)} │`);
    console.log(`│  🔐 API Key:  ${(server.apiKey.slice(0, 16) + "...").padEnd(44)} │`);
    console.log("└─────────────────────────────────────────────────────────────┘");
    console.log("");

    // ── Pre-populate with mock sessions ──────────────────────────────────

    console.log("Populating mock sessions...\n");

    // Start mock system monitor HTTP server for the service panel demo.
    const monitorServer = startMockSystemMonitor();
    const monitorPort = monitorServer.port;
    console.log(`  📊 Mock system monitor panel on port ${monitorPort}`);

    // Create a default mock runner so sessions have a runner association
    // and service_announce reaches viewers.
    const defaultRunner = await createMockRunner(server, {
        name: "sandbox-runner",
        roots: ["/Users/jordan/Documents/Projects/PizzaPi"],
        platform: "darwin",
        serviceIds: ["terminal", "file-explorer", "git", "tunnel", "system-monitor"],
        panels: [
            { serviceId: "system-monitor", port: monitorPort, label: "System Monitor", icon: "activity" },
        ],
        skills: [
            { name: "code-review", description: "Code review", filePath: "/skills/code-review/SKILL.md" },
            { name: "brainstorming", description: "Explore ideas", filePath: "/skills/brainstorming/SKILL.md" },
        ],
        agents: [
            { name: "task", description: "General-purpose task agent", filePath: "/agents/task.md" },
        ],
    });
    runners.push(defaultRunner);
    runnerCounter++;
    console.log(`  🖥️  Default runner: sandbox-runner (darwin) [${defaultRunner.runnerId.slice(0, 8)}...]`);

    // Session 1: active with a conversation
    const s1 = await scenario.addSession({
        cwd: "/Users/jordan/Documents/Projects/PizzaPi",
        collabMode: true,
    });
    sessionCounter++;
    s1.relay.emitEvent(s1.sessionId, s1.token, buildHeartbeat({
        active: true,
        sessionName: "refactor-auth-module",
        model: MODELS[0], // Sonnet 4.6
        cwd: "/Users/jordan/Documents/Projects/PizzaPi",
    }), 0);
    s1.relay.emitEvent(s1.sessionId, s1.token, { type: "model_changed", model: MODELS[0] });
    s1.relay.emitEvent(s1.sessionId, s1.token, {
        type: "token_usage_updated",
        tokenUsage: { input: 42_800, output: 3_200, cacheRead: 12_000, cacheWrite: 4_000, cost: 0.148, contextTokens: 42_800 },
        providerUsage: {},
    });

    // Stream a conversation with delays
    const convo = codeReviewConversation();
    for (let i = 0; i < convo.length; i++) {
        s1.relay.emitEvent(s1.sessionId, s1.token, convo[i], i + 1);
        await sleep(80);
    }
    // Link to runner so service_announce reaches viewers
    defaultRunner.emitSessionReady(s1.sessionId);
    console.log(`  🟢 Session 1: refactor-auth-module (Sonnet 4.6) — ${convo.length} events`);

    // Session 2: active, different model
    const s2 = await scenario.addSession({
        cwd: "/Users/jordan/Projects/cool-app",
        collabMode: true,
    });
    sessionCounter++;
    s2.relay.emitEvent(s2.sessionId, s2.token, buildHeartbeat({
        active: true,
        sessionName: "fix-dark-mode-css",
        model: MODELS[3], // GPT-5.4
        cwd: "/Users/jordan/Projects/cool-app",
    }), 0);
    s2.relay.emitEvent(s2.sessionId, s2.token, { type: "model_changed", model: MODELS[3] });
    s2.relay.emitEvent(s2.sessionId, s2.token, {
        type: "token_usage_updated",
        tokenUsage: { input: 95_400, output: 8_100, cacheRead: 0, cacheWrite: 0, cost: 0.312, contextTokens: 95_400 },
        providerUsage: {},
    });
    defaultRunner.emitSessionReady(s2.sessionId);
    console.log("  🟢 Session 2: fix-dark-mode-css (GPT-5.4)");

    // Session 3: child of session 1
    const s3 = await scenario.addSession({
        cwd: "/Users/jordan/Documents/Projects/PizzaPi",
        collabMode: true,
        parentSessionId: s1.sessionId,
    });
    sessionCounter++;
    s3.relay.emitEvent(s3.sessionId, s3.token, buildHeartbeat({
        active: true,
        sessionName: "code-review-subagent",
        model: MODELS[2], // Haiku 4.5
        cwd: "/Users/jordan/Documents/Projects/PizzaPi",
    }), 0);
    defaultRunner.emitSessionReady(s3.sessionId);
    console.log(`  🔗 Session 3: code-review-subagent (Haiku 4.5) → child of S1`);

    // ── Start Vite dev server for HMR ──────────────────────────────────
    const vitePort = await getFreePort();
    const serverPort = new URL(server.baseUrl).port;
    const uiDir = new URL("../../../ui", import.meta.url).pathname;
    const viteProc = Bun.spawn(
        ["bunx", "vite", "--port", String(vitePort), "--strictPort", "--host", "127.0.0.1"],
        {
            cwd: uiDir,
            // PORT tells the Vite proxy where to send API/WS requests.
            // PIZZAPI_SANDBOX_NO_TLS makes vite.config.ts skip TLS even if certs exist,
            // so headless browsers and curl work without cert gymnastics.
            env: { ...process.env, PORT: serverPort, PIZZAPI_SANDBOX_NO_TLS: "1" },
            stdout: "ignore",
            stderr: "ignore",
        },
    );
    // Wait for Vite to be ready (HTTP — TLS is disabled for sandbox)
    for (let i = 0; i < 40; i++) {
        await Bun.sleep(250);
        try {
            const resp = await fetch(`http://127.0.0.1:${vitePort}/`);
            if (resp.ok) break;
        } catch { /* not ready */ }
    }

    // Add the Vite dev URL as a trusted origin so auth works from the HMR UI.
    addTrustedOrigin(`http://127.0.0.1:${vitePort}`);

    // ── Start HTTP control API ────────────────────────────────────────
    const sandboxApi = await startSandboxApi({
        scenario,
        scenarios: SCENARIOS,
        models: MODELS,
        cwds: CWDS,
    });

    console.log(`\n✅ Sandbox ready!`);
    console.log(`   📺 UI (HMR):  http://127.0.0.1:${vitePort}`);
    console.log(`   🔌 Server:    ${server.baseUrl}`);
    console.log(`   🎮 API:       ${sandboxApi.baseUrl}\n`);

    // ── Live token ticker — grows s1 & s2 usage over time ───────────────
    // Simulates an active session consuming context so the donut animates.
    let s1Tokens = 42_800;
    let s2Tokens = 95_400;
    setInterval(() => {
        s1Tokens += Math.floor(Math.random() * 800 + 200);
        s1.relay.emitEvent(s1.sessionId, s1.token, {
            type: "token_usage_updated",
            tokenUsage: { input: s1Tokens, output: 3_200 + Math.floor(s1Tokens * 0.07), cacheRead: 12_000, cacheWrite: 4_000, cost: +(s1Tokens * 0.000003).toFixed(4), contextTokens: s1Tokens },
            providerUsage: {},
        });
        s2Tokens += Math.floor(Math.random() * 1_200 + 400);
        s2.relay.emitEvent(s2.sessionId, s2.token, {
            type: "token_usage_updated",
            tokenUsage: { input: s2Tokens, output: 8_100 + Math.floor(s2Tokens * 0.08), cacheRead: 0, cacheWrite: 0, cost: +(s2Tokens * 0.0000025).toFixed(4), contextTokens: s2Tokens },
            providerUsage: {},
        });
    }, 3_000);

    // ── Interactive REPL ─────────────────────────────────────────────────

    printHelp();

    // ── Async line reader ───────────────────────────────────────────────
    // Node's readline misbehaves under `bun run` and prompt() blocks the
    // event loop. Use a persistent stdin listener with a line queue so
    // the HTTP server stays responsive between commands.

    const lineQueue: string[] = [];
    let lineWaiter: ((line: string | null) => void) | null = null;
    let stdinEnded = false;

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
        const parts = (chunk as string).split("\n");
        // First part appends to any partial line from a previous chunk
        if (lineQueue.length > 0 && !lineQueue[lineQueue.length - 1].endsWith("\n")) {
            lineQueue[lineQueue.length - 1] += parts[0];
            parts.shift();
        }
        for (const part of parts) {
            lineQueue.push(part);
        }
        drainQueue();
    });
    process.stdin.on("end", () => {
        stdinEnded = true;
        if (lineWaiter) {
            const w = lineWaiter;
            lineWaiter = null;
            w(null);
        }
    });

    function drainQueue() {
        // A "line" is ready when we have at least 2 entries in the queue
        // (split on \n means the text before \n is complete).
        // Or if we have 1 entry and stdin ended.
        while (lineWaiter && lineQueue.length >= 2) {
            const line = lineQueue.shift()!;
            const w = lineWaiter;
            lineWaiter = null;
            w(line);
        }
    }

    function readLine(): Promise<string | null> {
        // Check if a complete line is already buffered
        if (lineQueue.length >= 2) {
            return Promise.resolve(lineQueue.shift()!);
        }
        if (stdinEnded) {
            return Promise.resolve(lineQueue.shift() ?? null);
        }
        return new Promise((resolve) => {
            lineWaiter = resolve;
        });
    }

    async function replLoop() {
        while (true) {
            process.stdout.write("🍕 sandbox> ");
            const line = await readLine();
            if (line === null) break; // EOF

            const trimmed = line.trim();
            if (!trimmed) continue;

            // Parse command and args, respecting quoted strings.
            // e.g. `runner "My Runner"` → cmd="runner", args=["My Runner"]
            const tokens: string[] = [];
            const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(trimmed)) !== null) {
                tokens.push(m[1] ?? m[2] ?? m[3]);
            }
            const [cmd, ...args] = tokens;

            try {
                switch (cmd) {
                    case "help":
                    case "h":
                        printHelp();
                        break;

                    case "status":
                    case "s":
                        printStatus(scenario);
                        break;

                    case "session":
                    case "add": {
                        const name = args[0] || pickRandom(SESSION_NAMES);
                        const model = pickRandom(MODELS);
                        const cwd = pickRandom(CWDS);
                        const sess = await scenario.addSession({ cwd, collabMode: true });
                        sessionCounter++;
                        sess.relay.emitEvent(sess.sessionId, sess.token, buildHeartbeat({
                            active: true,
                            sessionName: name,
                            model,
                            cwd,
                        }), 0);
                        defaultRunner.emitSessionReady(sess.sessionId);
                        const idx = scenario.sessions.length;
                        console.log(`  🟢 Session ${idx}: ${name} (${model.name}) [${sess.sessionId.slice(0, 8)}...]`);
                        break;
                    }

                    case "chat": {
                        const idx = parseInt(args[0] ?? "1", 10);
                        const scenarioName = args[1] || pickRandom(Object.keys(SCENARIOS));
                        const sess = scenario.sessions[idx - 1];
                        if (!sess) {
                            console.log(`  ❌ No session at index ${idx}. Use 'status' to see sessions.`);
                            break;
                        }
                        const chosen = SCENARIOS[scenarioName];
                        if (!chosen) {
                            console.log(`  ❌ Unknown scenario: ${scenarioName}. Options: ${Object.keys(SCENARIOS).join(", ")}`);
                            break;
                        }
                        console.log(`  📝 Streaming "${chosen.name}" into session ${idx}...`);
                        const events = chosen.builder();
                        for (let i = 0; i < events.length; i++) {
                            sess.relay.emitEvent(sess.sessionId, sess.token, events[i], i + 100);
                            await sleep(300); // slower so you can watch in the UI
                        }
                        console.log(`  ✅ Streamed ${events.length} events`);
                        break;
                    }

                    case "child": {
                        const parentIdx = parseInt(args[0] ?? "1", 10);
                        const parent = scenario.sessions[parentIdx - 1];
                        if (!parent) {
                            console.log(`  ❌ No session at index ${parentIdx}.`);
                            break;
                        }
                        const model = pickRandom(MODELS);
                        const child = await scenario.addSession({
                            cwd: pickRandom(CWDS),
                            collabMode: true,
                            parentSessionId: parent.sessionId,
                        });
                        sessionCounter++;
                        child.relay.emitEvent(child.sessionId, child.token, buildHeartbeat({
                            active: true,
                            sessionName: `subagent-${sessionCounter}`,
                            model,
                        }), 0);
                        defaultRunner.emitSessionReady(child.sessionId);
                        const childIdx = scenario.sessions.length;
                        console.log(`  🔗 Session ${childIdx}: subagent-${sessionCounter} (${model.name}) → child of S${parentIdx}`);
                        break;
                    }

                    case "end": {
                        const idx = parseInt(args[0] ?? "1", 10);
                        const sess = scenario.sessions[idx - 1];
                        if (!sess) {
                            console.log(`  ❌ No session at index ${idx}.`);
                            break;
                        }
                        sess.relay.emitSessionEnd(sess.sessionId, sess.token);
                        console.log(`  🔴 Session ${idx} ended`);
                        break;
                    }

                    case "heartbeat":
                    case "hb": {
                        const idx = parseInt(args[0] ?? "1", 10);
                        const active = args[1] !== "false";
                        const sess = scenario.sessions[idx - 1];
                        if (!sess) {
                            console.log(`  ❌ No session at index ${idx}.`);
                            break;
                        }
                        sess.relay.emitEvent(sess.sessionId, sess.token, buildHeartbeat({
                            active,
                        }), Date.now());
                        console.log(`  💓 Heartbeat sent to session ${idx} (active=${active})`);
                        break;
                    }

                    case "flood": {
                        const count = parseInt(args[0] ?? "10", 10);
                        console.log(`  🌊 Creating ${count} sessions...`);
                        for (let i = 0; i < count; i++) {
                            const name = pickRandom(SESSION_NAMES);
                            const model = pickRandom(MODELS);
                            const cwd = pickRandom(CWDS);
                            const sess = await scenario.addSession({ cwd, collabMode: true });
                            sessionCounter++;
                            sess.relay.emitEvent(sess.sessionId, sess.token, buildHeartbeat({
                                active: Math.random() > 0.3,
                                sessionName: `${name}-${sessionCounter}`,
                                model,
                                cwd,
                            }), 0);
                            defaultRunner.emitSessionReady(sess.sessionId);
                            await sleep(50);
                        }
                        console.log(`  ✅ Created ${count} sessions (total: ${scenario.sessions.length})`);
                        break;
                    }

                    case "oauth":
                    case "paste": {
                        const idx = parseInt(args[0] ?? "1", 10);
                        const serverName = args[1] || "figma";
                        const sess = scenario.sessions[idx - 1];
                        if (!sess) {
                            console.log(`  ❌ No session at index ${idx}. Use 'status' to see sessions.`);
                            break;
                        }
                        const nonce = Math.random().toString(36).slice(2, 18);
                        const authUrl = `https://www.figma.com/oauth?client_id=mock123&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback&scope=mcp%3Aconnect&state=mock_state&response_type=code`;
                        sess.relay.emitEvent(sess.sessionId, sess.token, {
                            type: "mcp_auth_paste_required",
                            serverName,
                            authUrl,
                            nonce,
                            ts: Date.now(),
                        });
                        console.log(`  🔐 Emitted mcp_auth_paste_required for "${serverName}" into session ${idx}`);
                        console.log(`     Nonce: ${nonce}`);
                        console.log(`     Auth URL: ${authUrl.slice(0, 60)}...`);

                        // Listen for the paste response routed through the server.
                        // The relay socket is in the session's room, so
                        // emitToRelaySession(..., "mcp_oauth_paste", ...) will
                        // reach us here.
                        const onPaste = (data: any) => {
                            if (data && typeof data === "object" && data.nonce === nonce) {
                                sess.relay.socket.off("mcp_oauth_paste" as any, onPaste);
                                console.log(`\n  ✅ OAuth paste received!`);
                                console.log(`     Nonce: ${data.nonce}`);
                                console.log(`     Code: ${data.code}`);
                                // Simulate auth completion
                                sess.relay.emitEvent(sess.sessionId, sess.token, {
                                    type: "mcp_auth_complete",
                                    serverName,
                                    ts: Date.now(),
                                });
                                console.log(`  🎉 Emitted mcp_auth_complete — paste UI should disappear`);
                                process.stdout.write("\n🍕 sandbox> ");
                            }
                        };
                        sess.relay.socket.on("mcp_oauth_paste" as any, onPaste);
                        break;
                    }

                    case "runner": {
                        const name = args[0] || `runner-${runnerCounter + 1}`;
                        const platform = pickRandom(["darwin", "linux", "darwin"]);
                        const roots = [pickRandom(CWDS)];
                        const runner = await createMockRunner(server, {
                            name,
                            roots,
                            platform,
                            skills: [
                                { name: "code-review", description: "Code review", filePath: "/skills/code-review/SKILL.md" },
                                { name: "test-driven-development", description: "TDD workflow", filePath: "/skills/tdd/SKILL.md" },
                                { name: "brainstorming", description: "Explore ideas", filePath: "/skills/brainstorming/SKILL.md" },
                            ],
                            agents: [
                                { name: "task", description: "General-purpose task agent", filePath: "/agents/task.md" },
                                { name: "reviewer", description: "Code reviewer", filePath: "/agents/reviewer.md" },
                            ],
                            serviceIds: ["terminal", "file-explorer", "git", "tunnel", "system-monitor"],
                        });
                        runnerCounter++;
                        runners.push(runner);
                        console.log(`  🖥️  Runner ${runnerCounter}: ${name} (${platform}) [${runner.runnerId.slice(0, 8)}...]`);
                        console.log(`     Roots: ${roots.join(", ")}`);
                        break;
                    }

                    case "runners": {
                        if (runners.length === 0) {
                            console.log("  No runners. Use 'runner [name]' to add one.");
                        } else {
                            console.log(`  ${runners.length} runner(s):`);
                            for (let i = 0; i < runners.length; i++) {
                                const r = runners[i];
                                const connected = r.socket.connected ? "🟢" : "🔴";
                                console.log(`    ${i + 1}. ${connected} ${r.runnerId.slice(0, 8)}...`);
                            }
                        }
                        break;
                    }

                    case "services": {
                        const serviceIds = args.length > 0
                            ? args
                            : ["terminal", "file-explorer", "git", "tunnel", "system-monitor"];
                        defaultRunner.announceServices(serviceIds);
                        console.log(`  📡 Announced services: ${serviceIds.join(", ")}`);
                        break;
                    }

                    case "quit":
                    case "q":
                    case "exit":
                        break; // exits switch, then return below

                    default:
                        console.log(`  ❓ Unknown command: ${cmd}. Type 'help' for commands.`);
                }

                if (cmd === "quit" || cmd === "q" || cmd === "exit") break; // exits while loop
            } catch (err) {
                console.error(`  💥 Error: ${(err as Error).message}`);
            }
        }
    }

    // Handle Ctrl+C for graceful shutdown
    process.on("SIGINT", () => {
        console.log("");
        doShutdown();
    });

    // If stdin is a TTY (interactive terminal), run the REPL.
    // Otherwise run headless — the HTTP API is the only control surface.
    const isInteractive = process.stdin.isTTY && !opts.headless;
    if (isInteractive) {
        process.stdin.resume();
        await replLoop();
        await doShutdown();
    } else {
        console.log("🤖 Running in headless mode (no TTY). Use the HTTP API to control the sandbox.");
        console.log(`   🎮 API: ${sandboxApi.baseUrl}\n`);
        // Keep the process alive — Ctrl+C / SIGTERM triggers doShutdown().
        process.on("SIGTERM", () => doShutdown());
        // Block forever by sleeping in a loop. Bun.sleep keeps the event loop alive.
        while (true) await Bun.sleep(60_000);
    }

    async function doShutdown() {
        console.log("🧹 Shutting down...");
        // Disconnect runners
        for (const r of runners) {
            try { await r.disconnect(); } catch {}
        }
        runners.length = 0;
        if (savedBaseUrl === undefined) {
            delete process.env.PIZZAPI_BASE_URL;
        } else {
            process.env.PIZZAPI_BASE_URL = savedBaseUrl;
        }
        sandboxApi.stop();
        monitorServer.stop();
        await scenario.teardown();
        viteProc.kill();
        await stopRedis();
        console.log("👋 Goodbye!\n");
        process.exit(0);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function printHelp() {
    console.log("Commands:");
    console.log("  session [name]       — Add a new mock session (random model/cwd)");
    console.log("  chat <n> [scenario]  — Stream a conversation into session n");
    console.log(`                         Scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
    console.log("  child <n>            — Spawn a child session linked to session n");
    console.log("  end <n>              — End session n");
    console.log("  heartbeat <n> [bool] — Send heartbeat (active=true/false)");
    console.log("  flood [count]        — Create N sessions at once (default: 10)");
    console.log("  oauth <n> [server]   — Simulate MCP OAuth paste prompt (e.g. figma)");
    console.log("  runner [name]        — Add a faux runner (with skills/agents)");
    console.log("  runners              — List all runners");
    console.log("  services [ids...]    — Re-announce services (default: all 5)");
    console.log("  status               — Show all sessions");
    console.log("  help                 — Show this help");
    console.log("  quit                 — Shut down and exit");
    console.log("");
}

function printStatus(scenario: TestScenario) {
    const sessions = scenario.sessions;
    if (sessions.length === 0) {
        console.log("  No sessions.");
        return;
    }
    console.log(`  ${sessions.length} session(s):`);
    for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        console.log(`    ${i + 1}. ${s.sessionId.slice(0, 8)}... → ${s.shareUrl}`);
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

if (import.meta.main) {
    main().catch((err) => {
        console.error("💥 Sandbox failed to start:", err);
        process.exit(1);
    });
}
