import { spawn, exec, execSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
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
import { io, type Socket } from "socket.io-client";
import type { RunnerClientToServerEvents, RunnerServerToClientEvents } from "@pizzapi/protocol";

interface RunnerSession {
    sessionId: string;
    child: ChildProcess | null;
    startedAt: number;
    /**
     * True if this session was re-adopted after a daemon restart.
     * Adopted sessions have no child process handle — the worker is still
     * running independently with its own relay connection.
     */
    adopted?: boolean;
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
//     "supervisorPid": 12344,  // PID of the outer supervisor process
//     "startedAt": "<iso>",    // ISO timestamp of that daemon start
//     "runnerId": "<uuid>",    // stable runner identity (never changes)
//     "runnerSecret": "<hex>"  // 32-byte secret used to re-authenticate
//   }

interface RunnerState {
    pid: number;
    supervisorPid?: number;
    startedAt: string;
    runnerId: string;
    runnerSecret: string;
}

export function defaultStatePath(): string {
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
            supervisorPid: typeof existing.supervisorPid === "number" ? existing.supervisorPid : undefined,
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
            supervisorPid: 0,
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

    // Read CLI version from package.json for reporting to the server.
    let cliVersion: string | undefined;
    try {
        const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        cliVersion = typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
        // Best-effort — version will be omitted if unreadable.
    }

    // Start fetching provider usage immediately so workers have cached data from
    // the moment they are spawned.  One daemon refresh covers all sessions on this node.
    startUsageRefreshLoop();

    const apiKey =
        process.env.PIZZAPI_RUNNER_API_KEY ??
        process.env.PIZZAPI_API_KEY ??
        process.env.PIZZAPI_API_TOKEN;
    const token = process.env.PIZZAPI_RUNNER_TOKEN;

    if (!apiKey && !token) {
        console.error("❌ Set PIZZAPI_API_KEY (or PIZZAPI_API_TOKEN) to run the runner daemon.");
        releaseStateLock(statePath);
        process.exit(1);
    }

    return new Promise((resolve) => {
        let isShuttingDown = false;

        // ── Socket.IO connection setup ────────────────────────────────────
        const relayRaw = (process.env.PIZZAPI_RELAY_URL ?? "ws://localhost:3001")
            .trim()
            .replace(/\/$/, "");

        // Normalise the relay URL for socket.io-client (needs http(s)://).
        // If the user supplies a bare hostname (no scheme), default to https://.
        function normaliseRelayUrl(raw: string): string {
            if (raw.startsWith("ws://"))      return raw.replace(/^ws:\/\//, "http://");
            if (raw.startsWith("wss://"))     return raw.replace(/^wss:\/\//, "https://");
            if (raw.startsWith("http://"))    return raw;
            if (raw.startsWith("https://"))   return raw;
            // No scheme — treat as an https host (e.g. "example.com" or "example.com:5173")
            return `https://${raw}`;
        }
        const sioUrl = normaliseRelayUrl(relayRaw);

        const runningSessions = new Map<string, RunnerSession>();
        const runnerName = process.env.PIZZAPI_RUNNER_NAME?.trim() || hostname();
        let runnerId: string | null = null;
        let isFirstConnect = true;

        const socket: Socket<RunnerServerToClientEvents, RunnerClientToServerEvents> = io(
            sioUrl + "/runner",
            {
                auth: {
                    apiKey,
                    runnerId: identity.runnerId,
                    runnerSecret: identity.runnerSecret,
                },
                transports: ["websocket"],
                reconnection: true,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 30000,
            },
        );

        console.log(`pizzapi runner: connecting to relay at ${sioUrl}/runner…`);

        const shutdown = (code: number) => {
            if (isShuttingDown) return;
            isShuttingDown = true;
            killAllTerminals();
            stopUsageRefreshLoop();
            releaseStateLock(statePath);
            socket.disconnect();
            resolve(code);
        };

        process.on("SIGINT", () => shutdown(0));
        process.on("SIGTERM", () => shutdown(0));

        // ── Helper: emit registration ─────────────────────────────────────
        const emitRegister = () => {
            const skills = scanGlobalSkills();
            socket.emit("register_runner", {
                runnerId: identity.runnerId,
                runnerSecret: identity.runnerSecret,
                name: runnerName,
                roots: getWorkspaceRoots(),
                skills,
                version: cliVersion,
            });
        };

        // ── Connection lifecycle ──────────────────────────────────────────

        socket.on("connect", () => {
            if (isShuttingDown) {
                socket.disconnect();
                return;
            }
            const verb = isFirstConnect ? "connected" : "reconnected";
            isFirstConnect = false;
            console.log(`pizzapi runner: ${verb}. Registering as ${identity.runnerId}…`);
            emitRegister();
        });

        socket.on("disconnect", (reason) => {
            if (isShuttingDown) return;
            console.log(`pizzapi runner: disconnected (${reason}). Socket.IO will reconnect automatically.`);
        });

        // ── Registration confirmation ─────────────────────────────────────

        socket.on("runner_registered", (data) => {
            runnerId = data.runnerId;
            if (runnerId !== identity.runnerId) {
                console.warn(
                    `pizzapi runner: server assigned unexpected ID ${runnerId} (expected ${identity.runnerId})`,
                );
            }
            console.log(`pizzapi runner: registered as ${runnerId}`);

            // Re-adopt orphaned sessions that survived a daemon restart.
            // Their worker processes are still running and connected to the relay.
            const existingSessions = data.existingSessions ?? [];
            if (existingSessions.length > 0) {
                let adopted = 0;
                for (const { sessionId, cwd } of existingSessions) {
                    if (runningSessions.has(sessionId)) continue; // already tracked
                    runningSessions.set(sessionId, {
                        sessionId,
                        child: null,
                        startedAt: Date.now(),
                        adopted: true,
                    });
                    adopted++;
                }
                if (adopted > 0) {
                    console.log(`pizzapi runner: re-adopted ${adopted} orphaned session(s): ${existingSessions.map(s => s.sessionId.slice(0, 8)).join(", ")}`);
                }
            }
        });

        // ── Session management ────────────────────────────────────────────

        socket.on("new_session", (data) => {
            if (isShuttingDown) return;
            const { sessionId, cwd: requestedCwd, prompt: requestedPrompt, model: requestedModel } = data;

            if (!sessionId) {
                socket.emit("session_error", { sessionId: sessionId ?? "", message: "Missing sessionId" });
                return;
            }

            // The worker uses the runner's API key to register with the /relay namespace.
            if (!apiKey) {
                socket.emit("session_error", { sessionId, message: "Runner is missing PIZZAPI_API_KEY" });
                return;
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
                    socket.emit("session_ready", { sessionId });
                } catch (err) {
                    socket.emit("session_error", {
                        sessionId,
                        message: err instanceof Error ? err.message : String(err),
                    });
                }
            };
            doSpawn();
        });

        socket.on("kill_session", (data) => {
            if (isShuttingDown) return;
            const { sessionId } = data;
            const entry = runningSessions.get(sessionId);
            if (entry) {
                if (entry.child) {
                    try {
                        entry.child.kill("SIGTERM");
                    } catch {}
                } else if (entry.adopted) {
                    // No child handle — ask the relay to disconnect the worker's
                    // socket, which sends end_session then force-disconnects.
                    socket.emit("disconnect_session", { sessionId });
                }
                runningSessions.delete(sessionId);
                console.log(`pizzapi runner: killed session ${sessionId}${entry.adopted ? " (adopted)" : ""}`);
                socket.emit("session_killed", { sessionId });
            }
        });

        // ── session_ended — relay notifies us a worker disconnected ───────
        socket.on("session_ended", (data) => {
            if (isShuttingDown) return;
            const { sessionId } = data;
            const entry = runningSessions.get(sessionId);
            if (entry) {
                runningSessions.delete(sessionId);
                console.log(`pizzapi runner: session ${sessionId} ended on relay${entry.adopted ? " (adopted)" : ""}`);
            }
        });

        socket.on("list_sessions", () => {
            if (isShuttingDown) return;
            // sessions_list is not in the typed protocol yet — emit untyped
            (socket as any).emit("sessions_list", {
                sessions: Array.from(runningSessions.keys()),
            });
        });

        // ── Daemon control ────────────────────────────────────────────────

        socket.on("restart", () => {
            console.log("pizzapi runner: restart request received. Exiting with code 42...");
            setTimeout(() => {
                shutdown(42);
            }, 500);
        });

        socket.on("shutdown", () => {
            console.log("pizzapi runner: shutdown request received. Exiting cleanly...");
            setTimeout(() => {
                shutdown(0);
            }, 500);
        });

        socket.on("ping", () => {
            if (isShuttingDown) return;
            // pong is not in the typed protocol yet — emit untyped
            (socket as any).emit("pong", { now: Date.now() });
        });

        // ── Terminal PTY management ───────────────────────────────────────

        socket.on("new_terminal", (data) => {
            if (isShuttingDown) return;
            const { terminalId, cwd: requestedCwd, cols, rows, shell } = data;
            console.log(
                `[terminal] new_terminal received: terminalId=${terminalId} cwd=${requestedCwd ?? "(default)"} cols=${cols ?? 80} rows=${rows ?? 24} shell=${shell ?? "(default)"}`,
            );
            if (!terminalId) {
                console.warn("[terminal] new_terminal: missing terminalId — rejecting");
                socket.emit("terminal_error", { terminalId: "", message: "Missing terminalId" });
                return;
            }
            if (requestedCwd && !isCwdAllowed(requestedCwd)) {
                console.warn(
                    `[terminal] new_terminal: cwd="${requestedCwd}" outside allowed roots — rejecting terminalId=${terminalId}`,
                );
                socket.emit("terminal_error", {
                    terminalId,
                    message: `cwd outside allowed roots: ${requestedCwd}`,
                });
                return;
            }
            // The terminal module calls termSend with { type: "terminal_*", ... } payloads.
            // Extract the type field and emit it as a socket.io event.
            const termSend = (payload: Record<string, unknown>) => {
                try {
                    const { type, runnerId: _drop, ...rest } = payload;
                    if (typeof type === "string") {
                        (socket as any).emit(type, rest);
                    }
                } catch (err) {
                    console.error(
                        `[terminal] termSend: failed to send ${payload.type} for terminalId=${terminalId}:`,
                        err,
                    );
                }
            };
            spawnTerminal(terminalId, termSend, {
                cwd: requestedCwd,
                cols,
                rows,
                shell,
            });
        });

        socket.on("terminal_input", (data) => {
            if (isShuttingDown) return;
            const { terminalId, data: inputData } = data;
            if (!terminalId || !inputData) {
                console.warn(
                    `[terminal] terminal_input: missing terminalId or data (terminalId=${terminalId} dataLen=${inputData?.length ?? 0})`,
                );
                return;
            }
            writeTerminalInput(terminalId, inputData);
        });

        socket.on("terminal_resize", (data) => {
            if (isShuttingDown) return;
            const { terminalId, cols, rows } = data;
            if (!terminalId) {
                console.warn("[terminal] terminal_resize: missing terminalId");
                return;
            }
            console.log(`[terminal] terminal_resize: terminalId=${terminalId} ${cols}x${rows}`);
            resizeTerminal(terminalId, cols, rows);
        });

        socket.on("kill_terminal", (data) => {
            if (isShuttingDown) return;
            const { terminalId } = data;
            if (!terminalId) {
                console.warn("[terminal] kill_terminal: missing terminalId");
                return;
            }
            console.log(`[terminal] kill_terminal: terminalId=${terminalId}`);
            const killed = killTerminal(terminalId);
            console.log(`[terminal] kill_terminal: result=${killed} terminalId=${terminalId}`);
            if (killed) {
                socket.emit("terminal_exit", { terminalId, exitCode: -1 });
            } else {
                socket.emit("terminal_error", { terminalId, message: "Terminal not found" });
            }
        });

        socket.on("list_terminals", () => {
            if (isShuttingDown) return;
            const list = listTerminals();
            console.log(`[terminal] list_terminals: ${list.length} active (${list.join(", ") || "none"})`);
            // terminals_list is not in the typed protocol yet — emit untyped
            (socket as any).emit("terminals_list", { terminals: list });
        });

        // ── Skills management ─────────────────────────────────────────────

        socket.on("list_skills", (data) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skills = scanGlobalSkills();
            socket.emit("skills_list", { skills, requestId });
        });

        socket.on("create_skill", async (data) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skillName = (data.name ?? "").trim();
            const skillContent = data.content ?? "";

            if (!skillName) {
                socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
                return;
            }

            if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(skillName) && !/^[a-z0-9]$/.test(skillName)) {
                socket.emit("skill_result", {
                    requestId,
                    ok: false,
                    message: "Invalid skill name: must be lowercase letters, numbers, and hyphens only",
                });
                return;
            }

            try {
                await writeSkill(skillName, skillContent);
                const skills = scanGlobalSkills();
                socket.emit("skill_result", { requestId, ok: true, skills });
            } catch (err) {
                socket.emit("skill_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("update_skill", async (data) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skillName = (data.name ?? "").trim();
            const skillContent = data.content ?? "";

            if (!skillName) {
                socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
                return;
            }

            if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(skillName) && !/^[a-z0-9]$/.test(skillName)) {
                socket.emit("skill_result", {
                    requestId,
                    ok: false,
                    message: "Invalid skill name: must be lowercase letters, numbers, and hyphens only",
                });
                return;
            }

            try {
                await writeSkill(skillName, skillContent);
                const skills = scanGlobalSkills();
                socket.emit("skill_result", { requestId, ok: true, skills });
            } catch (err) {
                socket.emit("skill_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("delete_skill", (data) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skillName = (data.name ?? "").trim();

            if (!skillName) {
                socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
                return;
            }

            const deleted = deleteSkill(skillName);
            const skills = scanGlobalSkills();
            socket.emit("skill_result", {
                requestId,
                ok: deleted,
                message: deleted ? undefined : "Skill not found",
                skills,
            });
        });

        socket.on("get_skill", (data) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const skillName = (data.name ?? "").trim();
            const content = skillName ? readSkillContent(skillName) : null;
            if (content === null) {
                socket.emit("skill_result", { requestId, ok: false, message: "Skill not found" });
            } else {
                socket.emit("skill_result", { requestId, ok: true, name: skillName, content });
            }
        });

        // ── File Explorer ─────────────────────────────────────────────────

        socket.on("list_files", async (data) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const dirPath = data.path ?? "";
            if (!dirPath) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing path" });
                return;
            }
            if (!isCwdAllowed(dirPath)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
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
                socket.emit("file_result", { requestId, ok: true, files: items });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("search_files", async (data) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const cwd = (data as any).cwd ?? "";
            const query = (data as any).query ?? "";
            const limit = typeof (data as any).limit === "number" ? (data as any).limit : 100;

            if (!cwd) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing cwd" });
                return;
            }
            if (!isCwdAllowed(cwd)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            if (!query) {
                socket.emit("file_result", { requestId, ok: true, files: [] });
                return;
            }
            try {
                // Use git ls-files to get tracked + untracked-not-ignored files.
                // Use async exec to avoid blocking the event loop (which would
                // prevent Socket.IO pings from being answered).
                const { stdout } = await execAsync(
                    "git ls-files --cached --others --exclude-standard",
                    { cwd, timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
                );
                const lowerQuery = query.toLowerCase();
                const files = stdout
                    .split("\n")
                    .filter((line) => {
                        if (!line) return false;
                        return line.toLowerCase().includes(lowerQuery);
                    })
                    .slice(0, limit)
                    .map((relativePath) => ({
                        name: relativePath.split("/").pop() ?? relativePath,
                        path: join(cwd, relativePath),
                        relativePath,
                        isDirectory: false,
                        isSymlink: false,
                    }));
                socket.emit("file_result", { requestId, ok: true, files });
            } catch (err) {
                // If git fails (not a git repo, etc.), return empty list
                const isGitError = err instanceof Error && (err as any).code !== undefined;
                if (isGitError) {
                    socket.emit("file_result", { requestId, ok: true, files: [] });
                    return;
                }
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("read_file", async (data) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const filePath = data.path ?? "";
            const encoding = (data as any).encoding ?? "utf8";
            const maxBytes = typeof (data as any).maxBytes === "number"
                ? (data as any).maxBytes
                : encoding === "base64"
                    ? 10 * 1024 * 1024
                    : 256 * 1024; // 10MB for base64, 256KB for text

            if (!filePath) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing path" });
                return;
            }
            if (!isCwdAllowed(filePath)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            try {
                const s = await stat(filePath);
                const truncated = s.size > maxBytes;
                if (encoding === "base64") {
                    const buf = await Bun.file(filePath).slice(0, maxBytes).arrayBuffer();
                    const b64 = Buffer.from(buf).toString("base64");
                    socket.emit("file_result", {
                        requestId,
                        ok: true,
                        content: b64,
                        encoding: "base64",
                        size: s.size,
                        truncated,
                    });
                } else {
                    const fd = await Bun.file(filePath).slice(0, maxBytes).text();
                    socket.emit("file_result", {
                        requestId,
                        ok: true,
                        content: fd,
                        size: s.size,
                        truncated,
                    });
                }
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        // ── Git operations ────────────────────────────────────────────────

        socket.on("git_status", async (data) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const cwd = data.cwd ?? "";
            if (!cwd) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing cwd" });
                return;
            }
            if (!isCwdAllowed(cwd)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            try {
                // Run all git commands asynchronously to avoid blocking the
                // event loop (which would prevent Socket.IO pings from being
                // answered, causing spurious disconnects).
                const [branchResult, statusResult, diffStagedResult, abResult] = await Promise.allSettled([
                    execAsync("git rev-parse --abbrev-ref HEAD", { cwd, timeout: 5000 }),
                    execAsync("git status --porcelain=v1 -uall", { cwd, timeout: 10000 }),
                    execAsync("git diff --cached --stat", { cwd, timeout: 10000 }),
                    execAsync("git rev-list --left-right --count HEAD...@{u}", { cwd, timeout: 5000 }),
                ]);

                const branch = branchResult.status === "fulfilled" ? branchResult.value.stdout.trim() : "";
                const statusOutput = statusResult.status === "fulfilled" ? statusResult.value.stdout : "";
                const diffStaged = diffStagedResult.status === "fulfilled" ? diffStagedResult.value.stdout : "";

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
                if (abResult.status === "fulfilled") {
                    const abOutput = abResult.value.stdout.trim();
                    const [a, b] = abOutput.split(/\s+/);
                    ahead = parseInt(a, 10) || 0;
                    behind = parseInt(b, 10) || 0;
                }

                socket.emit("file_result", {
                    requestId,
                    ok: true,
                    branch,
                    changes,
                    ahead,
                    behind,
                    diffStaged,
                });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        socket.on("git_diff", async (data) => {
            if (isShuttingDown) return;
            const requestId = data.requestId;
            const cwd = data.cwd ?? "";
            const filePath = (data as any).path ?? "";
            const staged = (data as any).staged === true;

            if (!cwd || !filePath) {
                socket.emit("file_result", { requestId, ok: false, message: "Missing cwd or path" });
                return;
            }
            if (!isCwdAllowed(cwd)) {
                socket.emit("file_result", { requestId, ok: false, message: "Path outside allowed roots" });
                return;
            }
            try {
                const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
                const { stdout: diff } = await execAsync(`git ${args.join(" ")}`, { cwd, timeout: 10000 });
                socket.emit("file_result", { requestId, ok: true, diff });
            } catch (err) {
                socket.emit("file_result", {
                    requestId,
                    ok: false,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });

        // ── Error handling ────────────────────────────────────────────────

        socket.on("error", (data) => {
            console.error(`pizzapi runner: server error: ${data.message}`);
        });
    });
}

export function isPidRunning(pid: number): boolean {
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

    const workerArgs = resolveWorkerSpawnArgs();

    const env: Record<string, string> = {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string")) as any,
        // Ensure relay URL is present for the remote extension in the worker.
        PIZZAPI_RELAY_URL: process.env.PIZZAPI_RELAY_URL ?? "ws://localhost:3001",
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

    const child = spawn(process.execPath, workerArgs, {
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

/** Is this process running inside a compiled Bun single-file binary? */
const isCompiledBinary = import.meta.url.startsWith("file:///$bunfs/");

/**
 * Returns the spawn arguments for starting a worker subprocess.
 * - Compiled binary: `[process.execPath, ["_worker"]]`
 * - Source / built JS: `[process.execPath, [workerFilePath]]`
 */
function resolveWorkerSpawnArgs(): string[] {
    if (isCompiledBinary) {
        // In a compiled binary, the worker code is embedded. We re-invoke
        // the same binary with the `_worker` subcommand.
        return ["_worker"];
    }

    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./worker.${ext}`, import.meta.url);
    const path = fileURLToPath(url);
    if (!existsSync(path)) {
        const altExt = ext === "ts" ? "js" : "ts";
        const alt = fileURLToPath(new URL(`./worker.${altExt}`, import.meta.url));
        if (existsSync(alt)) return [alt];
        throw new Error(`Runner worker entrypoint not found: ${path}`);
    }
    return [path];
}
