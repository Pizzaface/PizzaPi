import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readdir, stat, readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import {
    spawnTerminal,
    writeTerminalInput,
    resizeTerminal,
    killTerminal,
    listTerminals,
    killAllTerminals,
} from "./terminal.js";
import { join, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

interface RunnerSession {
    sessionId: string;
    child: ChildProcess;
    startedAt: number;
}

// ── Runner state file (~/.pizzapi/runner.json) ────────────────────────────────
//
// A single JSON file consolidates both the process-lock (pid + startedAt) and
// the persistent runner identity (runnerId + runnerSecret).  This keeps all
// runner state in the canonical ~/.pizzapi/ directory alongside config.json.
//
// Schema:
//   {
//     "pid": 12345,            // PID of the currently-running daemon (lock)
//     "startedAt": "<iso>",    // ISO timestamp of that daemon start
//     "runnerId": "<uuid>",    // stable runner identity (never changes)
//     "runnerSecret": "<hex>"  // 32-byte secret used to re-authenticate
//   }

interface RunnerState {
    pid: number;
    startedAt: string;
    runnerId: string;
    runnerSecret: string;
}

function defaultStatePath(): string {
    return process.env.PIZZAPI_RUNNER_STATE_PATH ?? join(homedir(), ".pizzapi", "runner.json");
}

/**
 * Acquire the runner lock and load (or create) the persistent identity.
 * Both live in a single JSON file so they stay in sync atomically.
 *
 * Returns the identity portion on success; exits the process if another
 * live runner already holds the lock.
 */
function acquireStateAndIdentity(statePath: string): { runnerId: string; runnerSecret: string } {
    // Ensure the parent directory exists.
    const dir = join(statePath, "..");
    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        // ignore — already exists or unwritable (caught below)
    }

    // Attempt up to two passes: one normal, one after clearing a stale lock.
    for (let attempt = 0; attempt < 2; attempt++) {
        let existing: Partial<RunnerState> = {};
        if (existsSync(statePath)) {
            try {
                existing = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<RunnerState>;
            } catch {
                // Corrupt file — treat as empty, overwrite below.
            }

            // Check whether another live daemon holds the lock.
            const pid = typeof existing.pid === "number" ? existing.pid : NaN;
            if (Number.isFinite(pid) && pid > 0) {
                if (isPidRunning(pid)) {
                    console.error(`❌ pizzapi runner already running (pid ${pid}, state: ${statePath}).`);
                    console.error("   Stop the existing runner process first, e.g.: kill ${pid}");
                    process.exit(1);
                }
                // PID is gone or belongs to an unrelated process — stale lock.
                console.log(`pizzapi runner: clearing stale lock (pid ${pid} is no longer a runner process)`);
            }
        }

        // Write the new lock (preserving identity if already present).
        const runnerId =
            typeof existing.runnerId === "string" && existing.runnerId.length > 0
                ? existing.runnerId
                : randomUUID();
        const runnerSecret =
            typeof existing.runnerSecret === "string" && existing.runnerSecret.length > 0
                ? existing.runnerSecret
                : randomBytes(32).toString("hex");

        const state: RunnerState = {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            runnerId,
            runnerSecret,
        };

        try {
            writeFileSync(statePath, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
            return { runnerId, runnerSecret };
        } catch (err: any) {
            console.error(`❌ Failed to write runner state to ${statePath}: ${err?.message ?? String(err)}`);
            process.exit(1);
        }
    }

    // Should never reach here.
    process.exit(1);
}

/**
 * Release the process lock by clearing the pid field in the state file,
 * while preserving the persistent identity for the next run.
 */
function releaseStateLock(statePath: string) {
    try {
        const existing = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<RunnerState>;
        // Only clear the lock fields; keep runnerId + runnerSecret intact.
        const updated = {
            pid: 0,
            startedAt: "",
            runnerId: existing.runnerId ?? "",
            runnerSecret: existing.runnerSecret ?? "",
        };
        writeFileSync(statePath, JSON.stringify(updated, null, 2), { encoding: "utf-8", mode: 0o600 });
    } catch {
        // Best-effort — ignore errors on shutdown.
    }
}

// ── Skill helpers ─────────────────────────────────────────────────────────────

/** Default global skills directory for PizzaPi. */
function globalSkillsDir(): string {
    return join(homedir(), ".pizzapi", "skills");
}

interface SkillMeta {
    name: string;
    description: string;
    filePath: string;
}

/**
 * Scan the global PizzaPi skills directory and return basic metadata.
 * Mirrors the discovery rules from the Agent Skills standard:
 *   - Direct .md files in the root → name = basename without extension
 *   - SKILL.md files under subdirectories → name = directory name
 */
function scanGlobalSkills(): SkillMeta[] {
    const dir = globalSkillsDir();
    if (!existsSync(dir)) return [];

    const skills: SkillMeta[] = [];

    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return [];
    }

    for (const entry of entries) {
        const fullPath = join(dir, entry);
        let st: ReturnType<typeof statSync>;
        try {
            st = statSync(fullPath);
        } catch {
            continue;
        }

        if (st.isFile() && entry.toLowerCase().endsWith(".md")) {
            // Direct .md file in root
            const name = entry.slice(0, -3);
            const { description } = parseSkillFrontmatter(fullPath);
            skills.push({ name, description, filePath: fullPath });
        } else if (st.isDirectory()) {
            // Look for SKILL.md inside
            const skillMd = join(fullPath, "SKILL.md");
            if (existsSync(skillMd)) {
                const { description } = parseSkillFrontmatter(skillMd);
                skills.push({ name: entry, description, filePath: skillMd });
            }
        }
    }

    return skills;
}

/**
 * Parse the `description` field out of a SKILL.md frontmatter block.
 * Returns empty string if not found or file is unreadable.
 */
function parseSkillFrontmatter(filePath: string): { description: string } {
    let content: string;
    try {
        content = readFileSync(filePath, "utf-8");
    } catch {
        return { description: "" };
    }

    // Frontmatter is between the first and second `---` lines.
    if (!content.startsWith("---")) return { description: "" };
    const end = content.indexOf("\n---", 3);
    if (end === -1) return { description: "" };

    const block = content.slice(3, end);
    const match = block.match(/^description:\s*(.+)$/m);
    return { description: match ? match[1].trim().replace(/^["']|["']$/g, "") : "" };
}

/**
 * Read the full content of a skill file.
 * For subdirectory skills (SKILL.md), returns the file content.
 * Returns null if not found.
 */
function readSkillContent(name: string): string | null {
    const dir = globalSkillsDir();

    // Try subdirectory first: <dir>/<name>/SKILL.md
    const subPath = join(dir, name, "SKILL.md");
    if (existsSync(subPath)) {
        try { return readFileSync(subPath, "utf-8"); } catch { return null; }
    }

    // Try direct file: <dir>/<name>.md
    const filePath = join(dir, `${name}.md`);
    if (existsSync(filePath)) {
        try { return readFileSync(filePath, "utf-8"); } catch { return null; }
    }

    return null;
}

/**
 * Write (create or update) a skill.
 * Uses the subdirectory layout: ~/.pizzapi/skills/<name>/SKILL.md
 */
async function writeSkill(name: string, content: string): Promise<void> {
    const dir = join(globalSkillsDir(), name);
    await mkdir(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

/**
 * Delete a skill by name.
 * Handles both subdirectory (SKILL.md) and direct (.md) layouts.
 */
function deleteSkill(name: string): boolean {
    const dir = globalSkillsDir();

    const subPath = join(dir, name);
    if (existsSync(join(subPath, "SKILL.md"))) {
        try {
            rmSync(subPath, { recursive: true, force: true });
            return true;
        } catch {
            return false;
        }
    }

    const filePath = join(dir, `${name}.md`);
    if (existsSync(filePath)) {
        try {
            rmSync(filePath);
            return true;
        } catch {
            return false;
        }
    }

    return false;
}

// ── Runner-wide usage cache (shared with worker processes via file) ───────────
//
// The runner daemon is the single source of truth for provider quota data on
// a given machine.  All worker sessions inherit PIZZAPI_RUNNER_USAGE_CACHE_PATH
// and read from this file instead of each making their own API calls.

interface UsageWindow { label: string; utilization: number; resets_at: string }
interface ProviderUsageData { windows: UsageWindow[] }
interface RunnerUsageCacheFile {
    fetchedAt: number;
    providers: Record<string, ProviderUsageData>;
}

/** Refresh interval — every 5 minutes, matching the per-session TTL in remote.ts */
const RUNNER_USAGE_REFRESH_INTERVAL = 5 * 60 * 1000;

let _usageRefreshTimer: ReturnType<typeof setInterval> | null = null;

function runnerUsageCacheFilePath(): string {
    return join(homedir(), ".pizzapi", "usage-cache.json");
}

/** Read auth.json from the default PizzaPi home (same file used by remote.ts). */
function readRunnerAuthJson(): Record<string, unknown> {
    try {
        const authPath = join(homedir(), ".pizzapi", "auth.json");
        if (!existsSync(authPath)) return {};
        return JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>;
    } catch {
        return {};
    }
}

async function fetchAnthropicUsageData(): Promise<ProviderUsageData | null> {
    const auth = readRunnerAuthJson();
    const token = (auth as any)?.anthropic?.access;
    if (!token || typeof token !== "string") return null;
    try {
        const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
            headers: {
                Authorization: `Bearer ${token}`,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "oauth-2025-04-20",
            },
        });
        if (!res.ok) return null;
        const raw = (await res.json()) as Record<string, unknown>;
        const WINDOW_LABELS: Record<string, string> = {
            five_hour: "5-hour",
            seven_day: "7-day",
            seven_day_opus: "7-day (Opus)",
            seven_day_sonnet: "7-day (Sonnet)",
            seven_day_oauth_apps: "7-day (OAuth apps)",
            seven_day_cowork: "7-day (co-work)",
        };
        const windows: UsageWindow[] = [];
        for (const [key, label] of Object.entries(WINDOW_LABELS)) {
            const w = raw[key] as { utilization: number; resets_at: string } | null | undefined;
            if (w?.resets_at != null && typeof w.utilization === "number") {
                windows.push({ label, utilization: w.utilization, resets_at: w.resets_at });
            }
        }
        return windows.length > 0 ? { windows } : null;
    } catch {
        return null;
    }
}

async function fetchGeminiUsageData(): Promise<ProviderUsageData | null> {
    const auth = readRunnerAuthJson();
    const rawCred = (auth as any)?.["google-gemini-cli"];
    if (!rawCred) return null;
    let token: string;
    let projectId: string;
    try {
        const parsed = (typeof rawCred === "string"
            ? JSON.parse(rawCred)
            : rawCred) as { token?: string; projectId?: string };
        if (!parsed.token || !parsed.projectId) return null;
        token = parsed.token;
        projectId = parsed.projectId;
    } catch {
        return null;
    }
    try {
        const endpoint = process.env["CODE_ASSIST_ENDPOINT"] ?? "https://cloudcode-pa.googleapis.com";
        const version = process.env["CODE_ASSIST_API_VERSION"] ?? "v1internal";
        const res = await fetch(`${endpoint}/${version}:retrieveUserQuota`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ project: projectId }),
        });
        if (!res.ok) return null;
        const raw = (await res.json()) as {
            buckets?: Array<{ remainingFraction?: number; resetTime?: string; tokenType?: string; modelId?: string }>;
        };
        const windows: UsageWindow[] = [];
        for (const bucket of raw.buckets ?? []) {
            if (bucket.remainingFraction == null || !bucket.resetTime) continue;
            const utilization = (1 - bucket.remainingFraction) * 100;
            const label = [bucket.tokenType, bucket.modelId].filter(Boolean).join(" / ") || "Quota";
            windows.push({ label, utilization, resets_at: bucket.resetTime });
        }
        return windows.length > 0 ? { windows } : null;
    } catch {
        return null;
    }
}

async function fetchCodexUsageData(): Promise<ProviderUsageData | null> {
    const auth = readRunnerAuthJson();
    const token = (auth as any)?.["openai-codex"]?.access;
    if (!token || typeof token !== "string") return null;
    try {
        const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return null;
        const raw = (await res.json()) as any;

        function windowLabel(minutes: number | null | undefined): string {
            if (!minutes) return "Usage";
            if (minutes < 60) return `${minutes}-min`;
            if (minutes < 60 * 24) return `${Math.round(minutes / 60)}-hour`;
            return `${Math.round(minutes / 60 / 24)}-day`;
        }
        function toWin(w: any, label: string): UsageWindow | null {
            if (!w) return null;
            const used = typeof w.used_percent === "number" ? w.used_percent : null;
            const resetAt = "resets_at" in w ? w.resets_at : "reset_at" in w ? w.reset_at : null;
            if (used == null || resetAt == null) return null;
            const minutes = "window_minutes" in w
                ? (w.window_minutes ?? undefined)
                : "limit_window_seconds" in w && typeof w.limit_window_seconds === "number"
                    ? Math.max(1, Math.round(w.limit_window_seconds / 60))
                    : undefined;
            return {
                label: minutes ? windowLabel(minutes) : label,
                utilization: used,
                resets_at: new Date(resetAt * 1000).toISOString(),
            };
        }

        const windows: UsageWindow[] = [];
        const primary = toWin(raw.rate_limit?.primary_window ?? raw.rate_limit?.primary, "Primary");
        if (primary) windows.push(primary);
        const secondary = toWin(raw.rate_limit?.secondary_window ?? raw.rate_limit?.secondary, "Secondary");
        if (secondary) windows.push(secondary);
        for (const extra of raw.additional_rate_limits ?? []) {
            const w = toWin(extra.rate_limit?.primary_window ?? extra.rate_limit?.primary, extra.limit_name);
            if (w) { w.label = extra.limit_name; windows.push(w); }
        }
        return windows.length > 0 ? { windows } : null;
    } catch {
        return null;
    }
}

/**
 * Fetch usage from all configured providers and write the result to the shared
 * cache file so every worker on this runner node can read it without making
 * their own API calls.
 */
async function refreshAndWriteRunnerUsageCache(): Promise<void> {
    const [anthropicResult, geminiResult, codexResult] = await Promise.allSettled([
        fetchAnthropicUsageData(),
        fetchGeminiUsageData(),
        fetchCodexUsageData(),
    ]);

    const providers: Record<string, ProviderUsageData> = {};
    if (anthropicResult.status === "fulfilled" && anthropicResult.value) {
        providers.anthropic = anthropicResult.value;
    }
    if (geminiResult.status === "fulfilled" && geminiResult.value) {
        providers["google-gemini-cli"] = geminiResult.value;
    }
    if (codexResult.status === "fulfilled" && codexResult.value) {
        providers["openai-codex"] = codexResult.value;
    }

    if (Object.keys(providers).length === 0) return; // No credentials available — skip write

    const cache: RunnerUsageCacheFile = { fetchedAt: Date.now(), providers };
    try {
        writeFileSync(runnerUsageCacheFilePath(), JSON.stringify(cache, null, 2), { encoding: "utf-8", mode: 0o600 });
        console.log(`pizzapi runner: usage cache refreshed (${Object.keys(providers).join(", ")})`);
    } catch (err: any) {
        console.warn(`pizzapi runner: failed to write usage cache: ${err?.message ?? String(err)}`);
    }
}

function startUsageRefreshLoop(): void {
    if (_usageRefreshTimer !== null) return;
    // Kick off an immediate fetch so workers spawned right after startup have data.
    void refreshAndWriteRunnerUsageCache();
    _usageRefreshTimer = setInterval(() => {
        void refreshAndWriteRunnerUsageCache();
    }, RUNNER_USAGE_REFRESH_INTERVAL);
}

function stopUsageRefreshLoop(): void {
    if (_usageRefreshTimer !== null) {
        clearInterval(_usageRefreshTimer);
        _usageRefreshTimer = null;
    }
}

/**
 * Remote Runner daemon.
 *
 * Connects to the PizzaPi relay server over WebSocket and registers itself as
 * an available runner. The relay server (and through it the web UI) can then:
 *
 *   - Request a new agent session be spawned  (new_session)
 *   - List active sessions                    (list_sessions)
 *   - Kill a session                          (kill_session)
 *
 * Authentication: API key via PIZZAPI_API_KEY env var (required).
 *                (Back-compat: PIZZAPI_RUNNER_TOKEN server token)
 * Relay URL:      PIZZAPI_RELAY_URL env var (default: ws://localhost:3001).
 * State file:     PIZZAPI_RUNNER_STATE_PATH env var (default: ~/.pizzapi/runner.json).
 */
export async function runDaemon(_args: string[] = []): Promise<number> {
    const statePath = defaultStatePath();
    const identity = acquireStateAndIdentity(statePath);

    // Start fetching provider usage immediately so workers have cached data from
    // the moment they are spawned.  One daemon refresh covers all sessions on this node.
    startUsageRefreshLoop();

    const apiKey = process.env.PIZZAPI_RUNNER_API_KEY ?? process.env.PIZZAPI_API_KEY;
    const token = process.env.PIZZAPI_RUNNER_TOKEN;

    if (!apiKey && !token) {
        console.error("❌ Set PIZZAPI_API_KEY (recommended) or PIZZAPI_RUNNER_TOKEN to run the runner daemon.");
        releaseStateLock(statePath);
        process.exit(1);
    }

    return new Promise((resolve) => {
        let isShuttingDown = false;
        let ws: WebSocket | null = null;

        const shutdown = (code: number) => {
            if (isShuttingDown) return;
            isShuttingDown = true;
            killAllTerminals();
            stopUsageRefreshLoop();
            releaseStateLock(statePath);
            if (ws) {
                ws.onclose = null;
                ws.onerror = null;
                ws.close();
            }
            resolve(code);
        };

        process.on("SIGINT", () => shutdown(0));
        process.on("SIGTERM", () => shutdown(0));

        const relayBase = (process.env.PIZZAPI_RELAY_URL ?? "ws://localhost:3001")
            .trim()
            .replace(/\/$/, "")
            .replace(/^http:\/\//, "ws://")
            .replace(/^https:\/\//, "wss://");
        const wsUrl = `${relayBase}/ws/runner`;

        const runningSessions = new Map<string, RunnerSession>();
        const runnerName = process.env.PIZZAPI_RUNNER_NAME?.trim() || hostname();

        // Exponential backoff state (shared across connect() calls so it persists).
        const RECONNECT_BASE = 1_000;   // 1 s
        const RECONNECT_MAX  = 60_000;  // 60 s
        let reconnectDelay = RECONNECT_BASE;

        console.log(`pizzapi runner: connecting to relay at ${wsUrl}…`);
        connect();

        function connect() {
            if (isShuttingDown) return;

            ws = new WebSocket(wsUrl, {
                headers: {
                    ...(apiKey ? { "x-api-key": apiKey } : { Authorization: `Bearer ${token}` }),
                },
            } as any);
            let runnerId: string | null = null;

            ws.onopen = () => {
                if (isShuttingDown) {
                    ws?.close();
                    return;
                }
                console.log(`pizzapi runner: connected. Registering as ${identity.runnerId}…`);
                const skills = scanGlobalSkills();
                ws?.send(
                    JSON.stringify({
                        type: "register_runner",
                        runnerId: identity.runnerId,
                        runnerSecret: identity.runnerSecret,
                        name: runnerName,
                        roots: getWorkspaceRoots(),
                        skills,
                    }),
                );
                // Reset backoff on successful connection.
                reconnectDelay = RECONNECT_BASE;
            };

            ws.onmessage = async (evt) => {
                if (isShuttingDown) return;
                let msg: Record<string, unknown>;
                try {
                    msg = JSON.parse(evt.data as string);
                } catch {
                    return;
                }

                switch (msg.type) {
                    case "runner_registered": {
                        runnerId = msg.runnerId as string;
                        if (runnerId !== identity.runnerId) {
                            console.warn(`pizzapi runner: server assigned unexpected ID ${runnerId} (expected ${identity.runnerId})`);
                        }
                        console.log(`pizzapi runner: registered as ${runnerId}`);
                        break;
                    }

                    case "new_session": {
                        const sessionId = msg.sessionId as string;
                        const requestedCwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
                        const requestedPrompt = typeof msg.prompt === "string" ? msg.prompt : undefined;
                        const requestedModel =
                            msg.model && typeof msg.model === "object" &&
                            typeof (msg.model as any).provider === "string" &&
                            typeof (msg.model as any).id === "string"
                                ? { provider: (msg.model as any).provider as string, id: (msg.model as any).id as string }
                                : undefined;

                        if (!sessionId) {
                            ws?.send(
                                JSON.stringify({
                                    type: "session_error",
                                    runnerId,
                                    sessionId,
                                    message: "Missing sessionId",
                                }),
                            );
                            break;
                        }

                        // The worker uses the runner's API key to register with /ws/sessions.
                        if (!apiKey) {
                            ws?.send(
                                JSON.stringify({
                                    type: "session_error",
                                    runnerId,
                                    sessionId,
                                    message: "Runner is missing PIZZAPI_API_KEY",
                                }),
                            );
                            break;
                        }

                        let isFirstSpawn = true;
                        const doSpawn = () => {
                            try {
                                // Only pass initial prompt/model on the first spawn.
                                // On restart (exit code 43), the session already has
                                // the prompt in its history — re-sending would duplicate it.
                                const spawnOpts = isFirstSpawn
                                    ? { prompt: requestedPrompt, model: requestedModel }
                                    : undefined;
                                isFirstSpawn = false;
                                spawnSession(sessionId, apiKey!, requestedCwd, runningSessions, doSpawn, spawnOpts);
                                ws?.send(JSON.stringify({ type: "session_ready", runnerId, sessionId }));
                            } catch (err) {
                                ws?.send(
                                    JSON.stringify({
                                        type: "session_error",
                                        runnerId,
                                        sessionId,
                                        message: err instanceof Error ? err.message : String(err),
                                    }),
                                );
                            }
                        };
                        doSpawn();
                        break;
                    }

                    case "kill_session": {
                        const sessionId = msg.sessionId as string;
                        const entry = runningSessions.get(sessionId);
                        if (entry) {
                            try {
                                entry.child.kill("SIGTERM");
                            } catch {}
                            runningSessions.delete(sessionId);
                            console.log(`pizzapi runner: killed session ${sessionId}`);
                            ws?.send(JSON.stringify({ type: "session_killed", runnerId, sessionId }));
                        }
                        break;
                    }

                    case "list_sessions": {
                        ws?.send(
                            JSON.stringify({
                                type: "sessions_list",
                                runnerId,
                                sessions: Array.from(runningSessions.keys()),
                            }),
                        );
                        break;
                    }

                    case "restart": {
                        console.log("pizzapi runner: restart request received. Exiting with code 42...");
                        // Give some time for the process to exit gracefully if needed
                        setTimeout(() => {
                            shutdown(42);
                        }, 500);
                        break;
                    }

                    case "ping": {
                        ws?.send(JSON.stringify({ type: "pong", runnerId, now: Date.now() }));
                        break;
                    }

                    // ── Terminal PTY management ───────────────────────────────
                    case "new_terminal": {
                        const terminalId = msg.terminalId as string;
                        const requestedCwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
                        const cols = typeof msg.cols === "number" ? msg.cols : undefined;
                        const rows = typeof msg.rows === "number" ? msg.rows : undefined;
                        const shell = typeof msg.shell === "string" ? msg.shell : undefined;
                        console.log(`[terminal] new_terminal received: terminalId=${terminalId} cwd=${requestedCwd ?? "(default)"} cols=${cols ?? 80} rows=${rows ?? 24} shell=${shell ?? "(default)"}`);
                        if (!terminalId) {
                            console.warn(`[terminal] new_terminal: missing terminalId — rejecting`);
                            ws?.send(JSON.stringify({ type: "terminal_error", runnerId, terminalId: "", message: "Missing terminalId" }));
                            break;
                        }
                        if (requestedCwd && !isCwdAllowed(requestedCwd)) {
                            console.warn(`[terminal] new_terminal: cwd="${requestedCwd}" outside allowed roots — rejecting terminalId=${terminalId}`);
                            ws?.send(JSON.stringify({ type: "terminal_error", runnerId, terminalId, message: `cwd outside allowed roots: ${requestedCwd}` }));
                            break;
                        }
                        const termSend = (payload: Record<string, unknown>) => {
                            try { ws?.send(JSON.stringify({ ...payload, runnerId })); } catch (err) {
                                console.error(`[terminal] termSend: failed to send ${payload.type} for terminalId=${terminalId}:`, err);
                            }
                        };
                        spawnTerminal(terminalId, termSend, {
                            cwd: requestedCwd,
                            cols,
                            rows,
                            shell,
                        });
                        break;
                    }

                    case "terminal_input": {
                        const terminalId = msg.terminalId as string;
                        const data = msg.data as string;
                        if (!terminalId || !data) {
                            console.warn(`[terminal] terminal_input: missing terminalId or data (terminalId=${terminalId} dataLen=${data?.length ?? 0})`);
                            break;
                        }
                        writeTerminalInput(terminalId, data);
                        break;
                    }

                    case "terminal_resize": {
                        const terminalId = msg.terminalId as string;
                        const cols = typeof msg.cols === "number" ? msg.cols : 0;
                        const rows = typeof msg.rows === "number" ? msg.rows : 0;
                        if (!terminalId) {
                            console.warn(`[terminal] terminal_resize: missing terminalId`);
                            break;
                        }
                        console.log(`[terminal] terminal_resize: terminalId=${terminalId} ${cols}x${rows}`);
                        resizeTerminal(terminalId, cols, rows);
                        break;
                    }

                    case "kill_terminal": {
                        const terminalId = msg.terminalId as string;
                        if (!terminalId) {
                            console.warn(`[terminal] kill_terminal: missing terminalId`);
                            break;
                        }
                        console.log(`[terminal] kill_terminal: terminalId=${terminalId}`);
                        const killed = killTerminal(terminalId);
                        console.log(`[terminal] kill_terminal: result=${killed} terminalId=${terminalId}`);
                        ws?.send(JSON.stringify({
                            type: killed ? "terminal_exit" : "terminal_error",
                            runnerId,
                            terminalId,
                            ...(killed ? { exitCode: -1 } : { message: "Terminal not found" }),
                        }));
                        break;
                    }

                    case "list_terminals": {
                        const list = listTerminals();
                        console.log(`[terminal] list_terminals: ${list.length} active (${list.join(", ") || "none"})`);
                        ws?.send(JSON.stringify({ type: "terminals_list", runnerId, terminals: list }));
                        break;
                    }

                    case "list_skills": {
                        const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
                        const skills = scanGlobalSkills();
                        ws?.send(JSON.stringify({ type: "skills_list", runnerId, requestId, skills }));
                        break;
                    }

                    case "create_skill":
                    case "update_skill": {
                        const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
                        const skillName = typeof msg.name === "string" ? msg.name.trim() : "";
                        const skillContent = typeof msg.content === "string" ? msg.content : "";

                        if (!skillName) {
                            ws?.send(JSON.stringify({ type: "skill_result", runnerId, requestId, ok: false, message: "Missing skill name" }));
                            break;
                        }

                        // Validate name format per Agent Skills standard
                        if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(skillName) && !/^[a-z0-9]$/.test(skillName)) {
                            ws?.send(JSON.stringify({ type: "skill_result", runnerId, requestId, ok: false, message: "Invalid skill name: must be lowercase letters, numbers, and hyphens only" }));
                            break;
                        }

                        try {
                            await writeSkill(skillName, skillContent);
                            const skills = scanGlobalSkills();
                            ws?.send(JSON.stringify({ type: "skill_result", runnerId, requestId, ok: true, skills }));
                        } catch (err) {
                            ws?.send(JSON.stringify({ type: "skill_result", runnerId, requestId, ok: false, message: err instanceof Error ? err.message : String(err) }));
                        }
                        break;
                    }

                    case "delete_skill": {
                        const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
                        const skillName = typeof msg.name === "string" ? msg.name.trim() : "";

                        if (!skillName) {
                            ws?.send(JSON.stringify({ type: "skill_result", runnerId, requestId, ok: false, message: "Missing skill name" }));
                            break;
                        }

                        const deleted = deleteSkill(skillName);
                        const skills = scanGlobalSkills();
                        ws?.send(JSON.stringify({ type: "skill_result", runnerId, requestId, ok: deleted, message: deleted ? undefined : "Skill not found", skills }));
                        break;
                    }

                    case "get_skill": {
                        const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
                        const skillName = typeof msg.name === "string" ? msg.name.trim() : "";
                        const content = skillName ? readSkillContent(skillName) : null;
                        if (content === null) {
                            ws?.send(JSON.stringify({ type: "skill_result", runnerId, requestId, ok: false, message: "Skill not found" }));
                        } else {
                            ws?.send(JSON.stringify({ type: "skill_result", runnerId, requestId, ok: true, name: skillName, content }));
                        }
                        break;
                    }

                    // ── File Explorer ─────────────────────────────────────────
                    case "list_files": {
                        const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
                        const dirPath = typeof msg.path === "string" ? msg.path : "";
                        if (!dirPath) {
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: false, message: "Missing path" }));
                            break;
                        }
                        if (!isCwdAllowed(dirPath)) {
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: false, message: "Path outside allowed roots" }));
                            break;
                        }
                        try {
                            const entries = await readdir(dirPath, { withFileTypes: true });
                            const items = await Promise.all(
                                entries
                                    .filter((e) => !e.name.startsWith(".") || e.name === ".gitignore" || e.name === ".env")
                                    .map(async (e) => {
                                        const fullPath = join(dirPath, e.name);
                                        let size: number | undefined;
                                        try {
                                            const s = await stat(fullPath);
                                            size = s.size;
                                        } catch {}
                                        return {
                                            name: e.name,
                                            path: fullPath,
                                            isDirectory: e.isDirectory(),
                                            isSymlink: e.isSymbolicLink(),
                                            size,
                                        };
                                    }),
                            );
                            // Directories first, then files, alphabetically
                            items.sort((a, b) => {
                                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                                return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
                            });
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: true, files: items }));
                        } catch (err) {
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: false, message: err instanceof Error ? err.message : String(err) }));
                        }
                        break;
                    }

                    case "read_file": {
                        const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
                        const filePath = typeof msg.path === "string" ? msg.path : "";
                        const encoding = typeof msg.encoding === "string" ? msg.encoding : "utf8";
                        const maxBytes = typeof msg.maxBytes === "number" ? msg.maxBytes : (encoding === "base64" ? 10 * 1024 * 1024 : 256 * 1024); // 10MB for base64, 256KB for text

                        if (!filePath) {
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: false, message: "Missing path" }));
                            break;
                        }
                        if (!isCwdAllowed(filePath)) {
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: false, message: "Path outside allowed roots" }));
                            break;
                        }
                        try {
                            const s = await stat(filePath);
                            const truncated = s.size > maxBytes;
                            if (encoding === "base64") {
                                const buf = await Bun.file(filePath).slice(0, maxBytes).arrayBuffer();
                                const b64 = Buffer.from(buf).toString("base64");
                                ws?.send(JSON.stringify({
                                    type: "file_result", runnerId, requestId, ok: true,
                                    content: b64,
                                    encoding: "base64",
                                    size: s.size,
                                    truncated,
                                }));
                            } else {
                                const fd = await Bun.file(filePath).slice(0, maxBytes).text();
                                ws?.send(JSON.stringify({
                                    type: "file_result", runnerId, requestId, ok: true,
                                    content: fd,
                                    size: s.size,
                                    truncated,
                                }));
                            }
                        } catch (err) {
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: false, message: err instanceof Error ? err.message : String(err) }));
                        }
                        break;
                    }

                    case "git_status": {
                        const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
                        const cwd = typeof msg.cwd === "string" ? msg.cwd : "";
                        if (!cwd) {
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: false, message: "Missing cwd" }));
                            break;
                        }
                        if (!isCwdAllowed(cwd)) {
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: false, message: "Path outside allowed roots" }));
                            break;
                        }
                        try {
                            // Get current branch
                            let branch = "";
                            try {
                                branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
                            } catch {}

                            // Get status --porcelain=v1
                            let statusOutput = "";
                            try {
                                statusOutput = execSync("git status --porcelain=v1 -uall", { cwd, encoding: "utf-8", timeout: 10000 });
                            } catch {}

                            // Get diff stat for staged changes
                            let diffStaged = "";
                            try {
                                diffStaged = execSync("git diff --cached --stat", { cwd, encoding: "utf-8", timeout: 10000 });
                            } catch {}

                            // Parse porcelain output
                            const changes: Array<{ status: string; path: string; originalPath?: string }> = [];
                            for (const line of statusOutput.split("\n")) {
                                if (!line.trim()) continue;
                                const xy = line.substring(0, 2);
                                const rest = line.substring(3);
                                // Handle renames: "R  old -> new"
                                const arrowIdx = rest.indexOf(" -> ");
                                if (arrowIdx >= 0) {
                                    changes.push({
                                        status: xy.trim(),
                                        path: rest.substring(arrowIdx + 4),
                                        originalPath: rest.substring(0, arrowIdx),
                                    });
                                } else {
                                    changes.push({ status: xy.trim(), path: rest });
                                }
                            }

                            // Get ahead/behind counts
                            let ahead = 0;
                            let behind = 0;
                            try {
                                const abOutput = execSync("git rev-list --left-right --count HEAD...@{u}", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
                                const [a, b] = abOutput.split(/\s+/);
                                ahead = parseInt(a, 10) || 0;
                                behind = parseInt(b, 10) || 0;
                            } catch {}

                            ws?.send(JSON.stringify({
                                type: "file_result", runnerId, requestId, ok: true,
                                branch,
                                changes,
                                ahead,
                                behind,
                                diffStaged,
                            }));
                        } catch (err) {
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: false, message: err instanceof Error ? err.message : String(err) }));
                        }
                        break;
                    }

                    case "git_diff": {
                        const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
                        const cwd = typeof msg.cwd === "string" ? msg.cwd : "";
                        const filePath = typeof msg.path === "string" ? msg.path : "";
                        const staged = msg.staged === true;

                        if (!cwd || !filePath) {
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: false, message: "Missing cwd or path" }));
                            break;
                        }
                        if (!isCwdAllowed(cwd)) {
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: false, message: "Path outside allowed roots" }));
                            break;
                        }
                        try {
                            const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
                            const diff = execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf-8", timeout: 10000 });
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: true, diff }));
                        } catch (err) {
                            ws?.send(JSON.stringify({ type: "file_result", runnerId, requestId, ok: false, message: err instanceof Error ? err.message : String(err) }));
                        }
                        break;
                    }
                }
            };

            ws.onerror = () => {
                // error will be followed by close, which handles reconnect
            };

            ws.onclose = () => {
                if (isShuttingDown) return;
                console.log(`pizzapi runner: disconnected. Reconnecting in ${reconnectDelay / 1000}s…`);
                const delay = reconnectDelay;
                // Double for next attempt, capped at RECONNECT_MAX.
                reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
                setTimeout(() => {
                    if (isShuttingDown) return;
                    connect();
                }, delay);
            };
        }
    });
}

function isPidRunning(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
    } catch (err: any) {
        // ESRCH = process does not exist. EPERM = exists but no permission.
        if (err?.code === "ESRCH") return false;
        // EPERM means the process exists but we can't signal it — treat as alive
        // but fall through to the command-line check below.
    }

    // The PID is alive, but it may have been reused by an unrelated process.
    // Verify the command line contains a pizzapi / runner signature.
    try {
        const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8", timeout: 3000 }).trim();
        // Match against known runner process patterns:
        //   - "bun ... runner"          (dev: bun packages/cli/src/index.ts runner)
        //   - "bun ... daemon.ts"       (dev: direct daemon run)
        //   - "bun ... _daemon"         (supervisor-spawned child)
        //   - "pizzapi ... runner"      (production CLI)
        //   - "node ... runner"         (unlikely but possible)
        const isRunner =
            /\brunner\b/.test(cmd) ||
            /\bdaemon\b/.test(cmd) ||
            /\bpizzapi\b/.test(cmd) ||
            /\b_daemon\b/.test(cmd);
        if (!isRunner) {
            // PID exists but belongs to an unrelated process — stale lock.
            return false;
        }
    } catch {
        // If we can't check the command (e.g. ps not available), fall back to
        // assuming the process is the runner (safe default — avoids double-start).
    }

    return true;
}

function parseRoots(raw: string): string[] {
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/\\/g, "/"))
        .map((s) => (s.length > 1 ? s.replace(/\/+$/, "") : s));
}

function getWorkspaceRoots(): string[] {
    // Preferred env vars
    const rootsRaw = process.env.PIZZAPI_WORKSPACE_ROOTS;
    const rootSingle = process.env.PIZZAPI_WORKSPACE_ROOT;

    // Back-compat
    const legacy = process.env.PIZZAPI_RUNNER_ROOTS;

    if (rootsRaw && rootsRaw.trim()) return parseRoots(rootsRaw);
    if (rootSingle && rootSingle.trim()) return parseRoots(rootSingle);
    if (legacy && legacy.trim()) return parseRoots(legacy);
    return [];
}

function isCwdAllowed(cwd: string | undefined): boolean {
    if (!cwd) return true;
    const roots = getWorkspaceRoots();
    if (roots.length === 0) return true; // unscoped runner
    const nCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    return roots.some((root) => nCwd === root || nCwd.startsWith(root + "/"));
}

function spawnSession(
    sessionId: string,
    apiKey: string,
    requestedCwd: string | undefined,
    runningSessions: Map<string, RunnerSession>,
    onRestartRequested?: () => void,
    options?: {
        prompt?: string;
        model?: { provider: string; id: string };
    },
): void {
    console.log(`pizzapi runner: spawning headless worker for session ${sessionId}…`);

    if (runningSessions.has(sessionId)) {
        throw new Error(`Session already running: ${sessionId}`);
    }

    if (!isCwdAllowed(requestedCwd)) {
        throw new Error(`Requested cwd is outside allowed workspace root(s): ${requestedCwd}`);
    }

    if (requestedCwd) {
        if (!existsSync(requestedCwd)) {
            throw new Error(`cwd does not exist: ${requestedCwd}`);
        }
        const st = statSync(requestedCwd);
        if (!st.isDirectory()) {
            throw new Error(`cwd is not a directory: ${requestedCwd}`);
        }
    }

    const workerPath = resolveWorkerEntryPoint();

    const env: Record<string, string> = {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string")) as any,
        // Ensure relay URL is present for the remote extension in the worker.
        PIZZAPI_RELAY_URL: process.env.PIZZAPI_RELAY_URL ?? "ws://localhost:3000",
        PIZZAPI_API_KEY: apiKey,
        PIZZAPI_SESSION_ID: sessionId,
        // Tell the worker where the runner-managed usage cache lives so it can
        // read quota data without making its own provider API calls.
        PIZZAPI_RUNNER_USAGE_CACHE_PATH: runnerUsageCacheFilePath(),
        ...(requestedCwd ? { PIZZAPI_WORKER_CWD: requestedCwd } : {}),
        // Initial prompt and model for the new session (set by spawn_session tool).
        ...(options?.prompt ? { PIZZAPI_WORKER_INITIAL_PROMPT: options.prompt } : {}),
        ...(options?.model ? {
            PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER: options.model.provider,
            PIZZAPI_WORKER_INITIAL_MODEL_ID: options.model.id,
        } : {}),
    };

    const child = spawn(process.execPath, [workerPath], {
        env,
        stdio: ["ignore", "inherit", "inherit"],
    });

    child.on("exit", (code, signal) => {
        runningSessions.delete(sessionId);
        console.log(`pizzapi runner: session ${sessionId} exited (code=${code}, signal=${signal})`);
        // Exit code 43 means the worker requested a restart (e.g. via /restart).
        // Re-spawn it and re-send session_ready so the runner→session link is preserved.
        if (code === 43 && onRestartRequested) {
            console.log(`pizzapi runner: re-spawning session ${sessionId} (worker restart requested)`);
            onRestartRequested();
        }
    });

    runningSessions.set(sessionId, { sessionId, child, startedAt: Date.now() });
    console.log(`pizzapi runner: session ${sessionId} worker spawned (pid=${child.pid})`);
}

function resolveWorkerEntryPoint(): string {
    // When running from TS sources via `bun`, import.meta.url ends with .ts.
    // When running from built output, it ends with .js.
    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./worker.${ext}`, import.meta.url);
    const path = fileURLToPath(url);
    if (!existsSync(path)) {
        // Fallback: try the other extension.
        const altExt = ext === "ts" ? "js" : "ts";
        const alt = fileURLToPath(new URL(`./worker.${altExt}`, import.meta.url));
        if (existsSync(alt)) return alt;
        throw new Error(`Runner worker entrypoint not found: ${path}`);
    }
    return path;
}
