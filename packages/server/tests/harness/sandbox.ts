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

// ── Suppress noisy server logs so the REPL stays clean ───────────────────────
// Keep errors but hide connection/disconnect/startup spam.
// Must be installed before any imports trigger server-side logging.
const _origLog = console.log;
const SUPPRESSED = [
    "[sio/relay]",
    "[sio/hub]",
    "[sio/viewer]",
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

async function startRedis(): Promise<(() => void)> {
    // 1. Honor an existing PIZZAPI_REDIS_URL — the caller already has Redis.
    const existingUrl = process.env.PIZZAPI_REDIS_URL;
    if (existingUrl) {
        const { createClient } = await import("redis");
        try {
            const probe = createClient({ url: existingUrl });
            await probe.connect();
            await probe.ping();
            await probe.quit();
            console.log(`  🟥 Using existing Redis at ${existingUrl}\n`);
            return () => {}; // nothing to clean up
        } catch {
            console.warn(`  ⚠️  PIZZAPI_REDIS_URL is set (${existingUrl}) but Redis is not reachable — falling through to Docker`);
        }
    }

    // 2. Probe for Docker before trying to spawn.
    const dockerCheck = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
    if (dockerCheck.exitCode !== 0) {
        throw new Error(
            "Redis is required but Docker is not available.\n" +
            "Either:\n" +
            "  • Install and start Docker, or\n" +
            "  • Set PIZZAPI_REDIS_URL to point at an existing Redis instance\n",
        );
    }

    // 3. Spawn a Redis container on a random free port.
    const port = await getFreePort();
    const redisUrl = `redis://127.0.0.1:${port}`;
    const containerName = `pizzapi-sandbox-redis-${port}`;

    const proc = Bun.spawn(
        ["docker", "run", "--rm", "-p", `${port}:6379`, "--name", containerName, "redis:alpine"],
        { stdout: "ignore", stderr: "ignore" },
    );

    const cleanup = () => {
        proc.kill();
        Bun.spawnSync(["docker", "rm", "-f", containerName], { stdout: "ignore", stderr: "ignore" });
        delete process.env.PIZZAPI_REDIS_URL;
    };

    // Wait for Redis to be ready (up to 10 s)
    const { createClient } = await import("redis");
    let ready = false;
    for (let i = 0; i < 40; i++) {
        await Bun.sleep(250);
        try {
            const probe = createClient({ url: redisUrl });
            await probe.connect();
            await probe.ping();
            await probe.quit();
            ready = true;
            break;
        } catch { /* not ready yet */ }
    }

    if (!ready) {
        cleanup();
        throw new Error(
            `Redis container started but never became ready on port ${port}.\n` +
            "Check Docker logs: docker logs " + containerName,
        );
    }

    // Point the harness server at our private Redis before it connects
    process.env.PIZZAPI_REDIS_URL = redisUrl;
    console.log(`  🟥 Redis ready on port ${port}\n`);

    return cleanup;
}

async function getFreePort(): Promise<number> {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
    const port = server.port;
    server.stop(true);
    return port;
}

async function main() {
    // Parse CLI args: bun run sandbox [port]
    const portArg = process.argv.find((a) => /^\d+$/.test(a));
    const requestedPort = portArg ? parseInt(portArg, 10) : 0;

    console.log("\n🍕 PizzaPi Sandbox\n");
    console.log("Starting server...\n");

    const stopRedis = await startRedis(); // always returns a cleanup fn now

    const scenario = new TestScenario();

    // Set PIZZAPI_BASE_URL before server init so share URLs work.
    // We'll update it once we know the actual port.
    const savedBaseUrl = process.env.PIZZAPI_BASE_URL;

    await scenario.setup({
        disableSignupAfterFirstUser: false,
        port: requestedPort,
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

    // Session 1: active with a conversation
    const s1 = await scenario.addSession({
        cwd: "/Users/jordan/Documents/Projects/PizzaPi",
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
    console.log(`  🟢 Session 1: refactor-auth-module (Sonnet 4.6) — ${convo.length} events`);

    // Session 2: active, different model
    const s2 = await scenario.addSession({
        cwd: "/Users/jordan/Projects/cool-app",
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
    console.log("  🟢 Session 2: fix-dark-mode-css (GPT-5.4)");

    // Session 3: child of session 1
    const s3 = await scenario.addSession({
        cwd: "/Users/jordan/Documents/Projects/PizzaPi",
        parentSessionId: s1.sessionId,
    });
    sessionCounter++;
    s3.relay.emitEvent(s3.sessionId, s3.token, buildHeartbeat({
        active: true,
        sessionName: "code-review-subagent",
        model: MODELS[2], // Haiku 4.5
        cwd: "/Users/jordan/Documents/Projects/PizzaPi",
    }), 0);
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

    console.log(`\n✅ Sandbox ready!`);
    console.log(`   📺 UI (HMR):  http://127.0.0.1:${vitePort}`);
    console.log(`   🔌 Server:    ${server.baseUrl}\n`);

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
                        const sess = await scenario.addSession({ cwd });
                        sessionCounter++;
                        sess.relay.emitEvent(sess.sessionId, sess.token, buildHeartbeat({
                            active: true,
                            sessionName: name,
                            model,
                            cwd,
                        }), 0);
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
                            parentSessionId: parent.sessionId,
                        });
                        sessionCounter++;
                        child.relay.emitEvent(child.sessionId, child.token, buildHeartbeat({
                            active: true,
                            sessionName: `subagent-${sessionCounter}`,
                            model,
                        }), 0);
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
                            const sess = await scenario.addSession({ cwd });
                            sessionCounter++;
                            sess.relay.emitEvent(sess.sessionId, sess.token, buildHeartbeat({
                                active: Math.random() > 0.3,
                                sessionName: `${name}-${sessionCounter}`,
                                model,
                                cwd,
                            }), 0);
                            await sleep(50);
                        }
                        console.log(`  ✅ Created ${count} sessions (total: ${scenario.sessions.length})`);
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

    process.stdin.resume();
    await replLoop();
    await doShutdown();

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
        await scenario.teardown();
        viteProc.kill();
        stopRedis();
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
    console.log("  runner [name]        — Add a faux runner (with skills/agents)");
    console.log("  runners              — List all runners");
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

main().catch((err) => {
    console.error("💥 Sandbox failed to start:", err);
    process.exit(1);
});
