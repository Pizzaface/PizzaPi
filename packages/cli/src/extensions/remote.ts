import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthStorage, buildSessionContext, SessionManager, type ExtensionContext, type ExtensionFactory, type SessionInfo } from "@mariozechner/pi-coding-agent";
import { loadConfig, defaultAgentDir } from "../config.js";
import { getMcpBridge } from "./mcp-bridge.js";
import { getCurrentTodoList, setTodoUpdateCallback, type TodoItem } from "./update-todo.js";
import type { RemoteExecRequest, RemoteExecResponse } from "./remote-commands.js";
import { messageBus } from "./session-message-bus.js";
import { io, type Socket } from "socket.io-client";
import type { RelayClientToServerEvents, RelayServerToClientEvents } from "@pizzapi/protocol";

interface RelayState {
    sessionId: string;
    token: string;
    shareUrl: string;
    /** Monotonic sequence number for the next event forwarded to relay */
    seq: number;
    /** Highest cumulative seq acknowledged by relay */
    ackedSeq: number;
}

interface AskUserQuestionParams {
    question: string;
    placeholder?: string;
    options?: string[];
}

interface AskUserQuestionDetails {
    question: string;
    options?: string[];
    answer: string | null;
    source: "tui" | "web" | null;
    cancelled: boolean;
    status?: "waiting" | "answered";
}

interface PendingAskUserQuestion {
    toolCallId: string;
    question: string;
    options?: string[];
    resolve: (answer: string | null) => void;
}

interface RelayModelInfo {
    provider: string;
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
}

const RELAY_DEFAULT = "ws://localhost:3001";
const RELAY_STATUS_KEY = "relay";
const ASK_USER_TOOL_NAME = "AskUserQuestion";

// ── Module-level CLI error forwarder ─────────────────────────────────────────
// Set by the factory so worker.ts can forward errors into the relay from outside
// the extension boundary (e.g. the bindExtensions onError callback).
let _cliErrorForwarder: ((message: string, source?: string) => void) | null = null;

/** Forward a CLI-side error to all active relay viewers. */
export function forwardCliError(message: string, source?: string): void {
    _cliErrorForwarder?.(message, source);
}

/**
 * PizzaPi Remote extension.
 *
 * Automatically connects to the PizzaPi relay on session start and streams all
 * agent events in real-time so any browser client can pick up the session.
 *
 * Config:
 *   PIZZAPI_RELAY_URL  WebSocket URL of the relay (default: ws://localhost:3000)
 *                      Set to "off" to disable auto-connect.
 *
 * Commands:
 *   /remote            Show the current share URL (or "not connected")
 *   /remote stop       Disconnect from relay
 *   /remote reconnect  Force reconnect
 *
 * Note: The `new_session` and `resume_session` exec handlers rely on a Bun
 * patch applied to `@mariozechner/pi-coding-agent` that exposes
 * `newSession()`/`switchSession()` on the extension runtime.
 * See `patches/README.md` for details.
 */
export const remoteExtension: ExtensionFactory = (pi) => {
    let relay: RelayState | null = null;
    let sioSocket: Socket<RelayServerToClientEvents, RelayClientToServerEvents> | null = null;
    let shuttingDown = false;
    let latestCtx: ExtensionContext | null = null;
    let pendingAskUserQuestion: PendingAskUserQuestion | null = null;
    let relaySessionId: string = (process.env.PIZZAPI_SESSION_ID && process.env.PIZZAPI_SESSION_ID.trim().length > 0)
        ? process.env.PIZZAPI_SESSION_ID.trim()
        : randomUUID();

    // ── Provider usage cache ──────────────────────────────────────────────────
    // Generic normalized shape shared with the UI.
    interface UsageWindow { label: string; utilization: number; resets_at: string }
    interface ProviderUsageData { windows: UsageWindow[] }

    const USAGE_CACHE_TTL = 5 * 60 * 1000; // 5 min
    const usageCache = new Map<string, { data: ProviderUsageData; fetchedAt: number }>();

    // When running as a runner-spawned worker the daemon is responsible for
    // fetching provider quota data and writing it to a shared cache file.
    // Reading from that file avoids N identical API calls (one per session).
    // CLI sessions (no env var) continue to fetch independently as before.
    const runnerUsageCachePath: string | null = process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH ?? null;

    function getOAuthToken(providerId: string): string | null {
        try {
            const config = loadConfig(process.cwd());
            const agentDir = config.agentDir
                ? config.agentDir.replace(/^~/, homedir())
                : defaultAgentDir();
            const authPath = join(agentDir, "auth.json");
            if (!existsSync(authPath)) return null;
            const auth = JSON.parse(readFileSync(authPath, "utf-8"));
            return (auth as any)?.[providerId]?.access ?? null;
        } catch {
            return null;
        }
    }

    function isCached(providerId: string): boolean {
        const entry = usageCache.get(providerId);
        return !!entry && Date.now() - entry.fetchedAt < USAGE_CACHE_TTL;
    }

    function buildProviderUsage(): Record<string, ProviderUsageData> {
        const out: Record<string, ProviderUsageData> = {};
        for (const [id, { data }] of usageCache) out[id] = data;
        return out;
    }

    /**
     * Read the runner daemon's shared usage cache file and populate the local
     * in-memory cache.  Called instead of direct API fetches for runner-spawned
     * sessions — the daemon is the single source of truth for quota data on this
     * node, so all sessions see the same numbers without redundant API calls.
     */
    async function refreshFromRunnerCache(): Promise<void> {
        if (!runnerUsageCachePath) return;
        try {
            if (!existsSync(runnerUsageCachePath)) return;
            const parsed = JSON.parse(readFileSync(runnerUsageCachePath, "utf-8")) as {
                fetchedAt: number;
                providers: Record<string, ProviderUsageData>;
            };
            const fetchedAt = typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0;
            for (const [id, data] of Object.entries(parsed.providers ?? {})) {
                if (data && Array.isArray((data as ProviderUsageData).windows)) {
                    usageCache.set(id, { data: data as ProviderUsageData, fetchedAt });
                }
            }
        } catch {
            // Non-fatal — cache file may not exist yet (daemon still starting) or
            // be temporarily unreadable.  Workers will show stale/empty data until
            // the daemon writes its first snapshot.
        }
    }

    async function refreshAnthropicUsage(): Promise<void> {
        if (isCached("anthropic")) return;
        const token = getOAuthToken("anthropic");
        if (!token) return;
        try {
            const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "anthropic-version": "2023-06-01",
                    "anthropic-beta": "oauth-2025-04-20",
                },
            });
            if (!res.ok) return;
            const raw = (await res.json()) as Record<string, unknown>;

            // Map known windows; ignore nulls and unknown fields.
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
            if (windows.length > 0) {
                usageCache.set("anthropic", { data: { windows }, fetchedAt: Date.now() });
            }
        } catch {
            // Non-fatal
        }
    }

    async function refreshCodexUsage(): Promise<void> {
        if (isCached("openai-codex")) return;
        const token = getOAuthToken("openai-codex");
        if (!token) return;
        try {
            // Codex subscription usage is served from ChatGPT backend APIs.
            const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });
            if (!res.ok) return;
            const raw = (await res.json()) as {
                plan_type?: string;
                rate_limit?: {
                    primary?: { used_percent: number; window_minutes?: number | null; resets_at?: number | null } | null;
                    secondary?: { used_percent: number; window_minutes?: number | null; resets_at?: number | null } | null;
                    primary_window?: { used_percent: number; limit_window_seconds?: number | null; reset_at?: number | null } | null;
                    secondary_window?: { used_percent: number; limit_window_seconds?: number | null; reset_at?: number | null } | null;
                } | null;
                code_review_rate_limit?: {
                    primary_window?: { used_percent: number; limit_window_seconds?: number | null; reset_at?: number | null } | null;
                    secondary_window?: { used_percent: number; limit_window_seconds?: number | null; reset_at?: number | null } | null;
                } | null;
                additional_rate_limits?: Array<{
                    limit_name: string;
                    metered_feature?: string;
                    rate_limit?: {
                        primary?: { used_percent: number; window_minutes?: number | null; resets_at?: number | null } | null;
                        primary_window?: { used_percent: number; limit_window_seconds?: number | null; reset_at?: number | null } | null;
                    } | null;
                }> | null;
            };

            function windowLabel(minutes: number | null | undefined): string {
                if (!minutes) return "Usage";
                if (minutes < 60) return `${minutes}-min`;
                if (minutes < 60 * 24) return `${Math.round(minutes / 60)}-hour`;
                return `${Math.round(minutes / 60 / 24)}-day`;
            }

            function toWindow(
                w:
                    | { used_percent: number; window_minutes?: number | null; resets_at?: number | null }
                    | { used_percent: number; limit_window_seconds?: number | null; reset_at?: number | null }
                    | null
                    | undefined,
                label: string,
            ): UsageWindow | null {
                if (!w) return null;
                const used = typeof w.used_percent === "number" ? w.used_percent : null;
                const resetAt =
                    "resets_at" in w
                        ? w.resets_at
                        : "reset_at" in w
                          ? w.reset_at
                          : null;
                if (used == null || resetAt == null) return null;

                const minutes =
                    "window_minutes" in w
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
            const primary = toWindow(raw.rate_limit?.primary_window ?? raw.rate_limit?.primary, "Primary");
            if (primary) windows.push(primary);
            const secondary = toWindow(raw.rate_limit?.secondary_window ?? raw.rate_limit?.secondary, "Secondary");
            if (secondary) windows.push(secondary);

            const review = toWindow(raw.code_review_rate_limit?.primary_window, "Code Review");
            if (review) {
                review.label = "Code Review";
                windows.push(review);
            }

            // Additional metered features (e.g. background tasks)
            for (const extra of raw.additional_rate_limits ?? []) {
                const w = toWindow(extra.rate_limit?.primary_window ?? extra.rate_limit?.primary, extra.limit_name);
                if (w) {
                    w.label = extra.limit_name;
                    windows.push(w);
                }
            }

            if (windows.length > 0) {
                usageCache.set("openai-codex", { data: { windows }, fetchedAt: Date.now() });
            }
        } catch {
            // Non-fatal
        }
    }

    async function refreshGeminiUsage(): Promise<void> {
        if (isCached("google-gemini-cli")) return;
        // Credentials are stored as JSON: { token, projectId }
        let token: string;
        let projectId: string;
        try {
            const config = loadConfig(process.cwd());
            const agentDir = config.agentDir ? config.agentDir.replace(/^~/, homedir()) : defaultAgentDir();
            const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
            const raw = await authStorage.getApiKey("google-gemini-cli");
            if (!raw) return;
            const parsed = JSON.parse(raw) as { token?: string; projectId?: string };
            if (!parsed.token || !parsed.projectId) return;
            token = parsed.token;
            projectId = parsed.projectId;
        } catch {
            return;
        }

        try {
            const endpoint = process.env["CODE_ASSIST_ENDPOINT"] ?? "https://cloudcode-pa.googleapis.com";
            const version = process.env["CODE_ASSIST_API_VERSION"] ?? "v1internal";
            const res = await fetch(`${endpoint}/${version}:retrieveUserQuota`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ project: projectId }),
            });
            if (!res.ok) return;

            const raw = (await res.json()) as {
                buckets?: Array<{
                    remainingAmount?: string;
                    remainingFraction?: number;
                    resetTime?: string;
                    tokenType?: string;
                    modelId?: string;
                }>;
            };

            const windows: UsageWindow[] = [];
            for (const bucket of raw.buckets ?? []) {
                if (bucket.remainingFraction == null || !bucket.resetTime) continue;
                // API returns remaining fraction (0–1); convert to utilization (0–100 used)
                const utilization = (1 - bucket.remainingFraction) * 100;
                const label = [bucket.tokenType, bucket.modelId].filter(Boolean).join(" / ") || "Quota";
                windows.push({ label, utilization, resets_at: bucket.resetTime });
            }
            if (windows.length > 0) {
                usageCache.set("google-gemini-cli", { data: { windows }, fetchedAt: Date.now() });
            }
        } catch {
            // Non-fatal
        }
    }

    async function refreshAllUsage(): Promise<void> {
        if (runnerUsageCachePath) {
            // Runner-spawned worker: read the daemon's shared cache instead of
            // making independent API calls.  The daemon already fetches on our
            // behalf and keeps the file fresh every 5 minutes.
            await refreshFromRunnerCache();
            return;
        }
        // CLI session: fetch directly from each provider as before.
        await Promise.allSettled([
            refreshAnthropicUsage(),
            refreshCodexUsage(),
            refreshGeminiUsage(),
        ]);
    }

    // ── Heartbeat state ───────────────────────────────────────────────────────
    let isAgentActive = false;
    let sessionStartedAt: number | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    // ── Session name sync state ───────────────────────────────────────────────
    // Keeps web viewers in sync when /name is run directly in the TUI.
    let sessionNameSyncTimer: ReturnType<typeof setInterval> | null = null;
    let lastBroadcastSessionName: string | null = null;

    // ── Core relay helpers ────────────────────────────────────────────────────

    function relayUrl(): string {
        const configured =
            process.env.PIZZAPI_RELAY_URL ??
            loadConfig(process.cwd()).relayUrl ??
            RELAY_DEFAULT;
        return configured.replace(/\/$/, "");
    }

    function toWebSocketBaseUrl(value: string): string {
        const trimmed = value.trim().replace(/\/$/, "");
        if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
            return trimmed;
        }
        if (trimmed.startsWith("http://")) {
            return `ws://${trimmed.slice("http://".length)}`;
        }
        if (trimmed.startsWith("https://")) {
            return `wss://${trimmed.slice("https://".length)}`;
        }
        // No scheme — treat as a secure remote host (e.g. "example.com" or "example.com:5173")
        return `wss://${trimmed}`;
    }

    function isDisabled(): boolean {
        const configured = process.env.PIZZAPI_RELAY_URL ?? loadConfig(process.cwd()).relayUrl ?? "";
        return configured.toLowerCase() === "off";
    }

    // Wire up module-level error forwarder so worker.ts can push errors into the relay.
    _cliErrorForwarder = (message, source) => {
        forwardEvent({ type: "cli_error", message, source: source ?? null, ts: Date.now() });
    };

    // Wire up todo update callback so the web UI gets live updates when the model
    // calls the `update_todo` tool.
    setTodoUpdateCallback((list: TodoItem[]) => {
        forwardEvent({ type: "todo_update", todos: list, ts: Date.now() });
    });

    function forwardEvent(event: unknown) {
        if (!relay || !sioSocket?.connected) return;
        const seq = ++relay.seq;
        sioSocket.emit("event", { sessionId: relay.sessionId, token: relay.token, event, seq });
    }

    type RemoteInputAttachment = {
        attachmentId?: string;
        mediaType?: string;
        filename?: string;
        url?: string;
    };

    function normalizeRemoteInputAttachments(raw: unknown): RemoteInputAttachment[] {
        if (!Array.isArray(raw)) return [];
        return raw
            .filter((item) => item && typeof item === "object")
            .map((item) => {
                const record = item as Record<string, unknown>;
                return {
                    attachmentId: typeof record.attachmentId === "string" ? record.attachmentId : undefined,
                    mediaType: typeof record.mediaType === "string" ? record.mediaType : undefined,
                    filename: typeof record.filename === "string" ? record.filename : undefined,
                    url: typeof record.url === "string" ? record.url : undefined,
                } satisfies RemoteInputAttachment;
            })
            .filter((item) =>
                (typeof item.attachmentId === "string" && item.attachmentId.length > 0) ||
                (typeof item.url === "string" && item.url.length > 0),
            );
    }

    function parseDataUrl(url: string): { mediaType: string; data: string } | null {
        const match = /^data:([^;,]+)?;base64,(.+)$/i.exec(url);
        if (!match) return null;
        return {
            mediaType: match[1] || "application/octet-stream",
            data: match[2],
        };
    }

    function relayHttpBaseUrl(): string {
        const wsBase = toWebSocketBaseUrl(relayUrl()).replace(/\/ws\/sessions$/, "");
        if (wsBase.startsWith("ws://")) return `http://${wsBase.slice("ws://".length)}`;
        if (wsBase.startsWith("wss://")) return `https://${wsBase.slice("wss://".length)}`;
        return wsBase;
    }

    async function loadAttachmentFromRelay(attachmentId: string): Promise<{ mediaType: string; filename?: string; dataBase64: string } | null> {
        const key = apiKey();
        if (!key) return null;

        const response = await fetch(`${relayHttpBaseUrl()}/api/attachments/${encodeURIComponent(attachmentId)}`, {
            headers: { "x-api-key": key },
        });

        if (!response.ok) return null;

        const mediaType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
        const filename = response.headers.get("x-attachment-filename") ?? undefined;
        const dataBase64 = Buffer.from(await response.arrayBuffer()).toString("base64");

        return { mediaType, filename, dataBase64 };
    }

    async function buildUserMessageFromRemoteInput(text: string, attachments: RemoteInputAttachment[]): Promise<string | unknown[]> {
        if (attachments.length === 0) return text;

        const parts: unknown[] = [];
        if (text.length > 0) {
            parts.push({ type: "text", text });
        }

        for (const attachment of attachments) {
            let mediaType = attachment.mediaType || "application/octet-stream";
            let filename = attachment.filename;
            let dataBase64: string | null = null;

            if (attachment.attachmentId) {
                const loaded = await loadAttachmentFromRelay(attachment.attachmentId);
                if (loaded) {
                    mediaType = loaded.mediaType;
                    filename = loaded.filename ?? filename;
                    dataBase64 = loaded.dataBase64;
                }
            } else if (attachment.url) {
                const parsed = parseDataUrl(attachment.url);
                if (parsed) {
                    mediaType = parsed.mediaType;
                    dataBase64 = parsed.data;
                }
            }

            if (dataBase64 && mediaType.startsWith("image/")) {
                parts.push({
                    type: "image",
                    mimeType: mediaType,
                    data: dataBase64,
                });
                continue;
            }

            const label = filename || mediaType || "attachment";
            parts.push({ type: "text", text: `[Attachment provided by web client: ${label}]` });
        }

        return parts.length > 0 ? parts : text;
    }

    function buildTokenUsage() {
        if (!latestCtx) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
        for (const entry of latestCtx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
                input += entry.message.usage.input;
                output += entry.message.usage.output;
                cacheRead += entry.message.usage.cacheRead;
                cacheWrite += entry.message.usage.cacheWrite;
                cost += entry.message.usage.cost.total;
            }
        }
        return { input, output, cacheRead, cacheWrite, cost };
    }

    function getCurrentSessionName(ctx: ExtensionContext | null | undefined): string | null {
        if (!ctx) return null;
        const raw = ctx.sessionManager.getSessionName();
        if (typeof raw !== "string") return null;
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    function getCurrentThinkingLevel(ctx: ExtensionContext | null | undefined): string | null {
        const api = pi as any;
        if (typeof api.getThinkingLevel === "function") {
            const level = api.getThinkingLevel();
            if (typeof level === "string") {
                const trimmed = level.trim();
                if (trimmed) return trimmed;
            }
        }

        if (!ctx) return null;
        const { thinkingLevel } = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
        return thinkingLevel ?? null;
    }

    function buildHeartbeat() {
        const thinkingLevel = getCurrentThinkingLevel(latestCtx);

        return {
            type: "heartbeat",
            active: isAgentActive,
            model: latestCtx?.model
                ? { provider: latestCtx.model.provider, id: latestCtx.model.id, name: latestCtx.model.name, reasoning: latestCtx.model.reasoning }
                : null,
            sessionName: getCurrentSessionName(latestCtx),
            thinkingLevel: thinkingLevel ?? null,
            tokenUsage: buildTokenUsage(),
            cwd: latestCtx?.cwd ?? null,
            uptime: sessionStartedAt !== null ? Date.now() - sessionStartedAt : null,
            ts: Date.now(),
            providerUsage: buildProviderUsage(),
            todoList: getCurrentTodoList(),
            pendingQuestion: pendingAskUserQuestion
                ? {
                      toolCallId: pendingAskUserQuestion.toolCallId,
                      question: pendingAskUserQuestion.question,
                      options: pendingAskUserQuestion.options,
                  }
                : null,
        };
    }

    function startHeartbeat() {
        stopHeartbeat();
        // Send an immediate heartbeat so the viewer has state right away.
        forwardEvent(buildHeartbeat());
        heartbeatTimer = setInterval(() => {
            void refreshAllUsage();
            forwardEvent(buildHeartbeat());
        }, 10_000);
    }

    function stopHeartbeat() {
        if (heartbeatTimer !== null) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    function stopSessionNameSync() {
        if (sessionNameSyncTimer !== null) {
            clearInterval(sessionNameSyncTimer);
            sessionNameSyncTimer = null;
        }
    }

    function markSessionNameBroadcasted() {
        lastBroadcastSessionName = getCurrentSessionName(latestCtx);
    }

    function startSessionNameSync() {
        stopSessionNameSync();
        markSessionNameBroadcasted();

        sessionNameSyncTimer = setInterval(() => {
            const currentSessionName = getCurrentSessionName(latestCtx);
            if (currentSessionName === lastBroadcastSessionName) return;

            lastBroadcastSessionName = currentSessionName;
            forwardEvent({ type: "session_active", state: buildSessionState() });
            forwardEvent(buildHeartbeat());
        }, 1000);
    }

    function getConfiguredModels(ctx: ExtensionContext): RelayModelInfo[] {
        return ctx.modelRegistry
            .getAvailable()
            .map((model) => ({
                provider: model.provider,
                id: model.id,
                name: model.name,
                reasoning: model.reasoning,
                contextWindow: model.contextWindow,
            }))
            .sort((a, b) => {
                if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
                return a.id.localeCompare(b.id);
            });
    }

    function buildSessionState() {
        if (!latestCtx) return undefined;
        const { messages, model } = buildSessionContext(
            latestCtx.sessionManager.getEntries(),
            latestCtx.sessionManager.getLeafId(),
        );
        return {
            messages,
            model,
            thinkingLevel: getCurrentThinkingLevel(latestCtx),
            sessionName: getCurrentSessionName(latestCtx),
            cwd: latestCtx.cwd,
            availableModels: getConfiguredModels(latestCtx),
            todoList: getCurrentTodoList(),
        };
    }

    function buildCapabilitiesState() {
        if (!latestCtx) {
            return {
                type: "capabilities",
                models: [],
                commands: [],
            };
        }

        const commands = (pi.getCommands?.() ?? []).map((c: any) => ({
            name: c.name,
            description: c.description,
        }));

        return {
            type: "capabilities",
            models: getConfiguredModels(latestCtx),
            commands,
        };
    }

    function sendToWeb(payload: RemoteExecResponse) {
        if (!relay || !sioSocket?.connected) return;
        // Strip the `type` discriminant — socket.io uses the event name instead.
        const { type: _, ...data } = payload;
        sioSocket.emit("exec_result", data);
    }

    async function listSessionsForResume(ctx: ExtensionContext): Promise<SessionInfo[]> {
        const cwd = ctx.sessionManager.getCwd();
        const sessionDir = ctx.sessionManager.getSessionDir();
        const sessions = await SessionManager.list(cwd, sessionDir);
        return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    }

    function pickResumeSession(sessions: SessionInfo[], currentPath: string | undefined, query?: string): SessionInfo | null {
        const normalized = query?.trim().toLowerCase();
        const candidates = sessions.filter((session) => session.path !== currentPath);
        if (candidates.length === 0) return null;

        if (!normalized) {
            return candidates[0] ?? null;
        }

        return (
            candidates.find((session) => {
                const id = session.id.toLowerCase();
                const path = session.path.toLowerCase();
                const name = (session.name ?? "").toLowerCase();
                const firstMessage = (session.firstMessage ?? "").toLowerCase();
                return (
                    id.includes(normalized) ||
                    path.includes(normalized) ||
                    name.includes(normalized) ||
                    firstMessage.includes(normalized)
                );
            }) ?? null
        );
    }

    function toResumeSessionSummary(session: SessionInfo) {
        return {
            id: session.id,
            path: session.path,
            name: session.name ?? null,
            modified: session.modified.toISOString(),
            firstMessage: session.firstMessage,
        };
    }

    async function handleExecFromWeb(req: RemoteExecRequest) {
        const replyOk = (result?: unknown) => sendToWeb({ type: "exec_result", id: req.id, ok: true, command: req.command, result });
        const replyErr = (error: string) => sendToWeb({ type: "exec_result", id: req.id, ok: false, command: req.command, error });

        try {
            if (req.command === "get_commands") {
                // Return the same list we already advertise in capabilities
                const commands = (pi.getCommands?.() ?? []).map((c: any) => ({ name: c.name, description: c.description }));
                replyOk({ commands });
                return;
            }

            if (req.command === "mcp") {
                const bridge = getMcpBridge();
                if (!bridge) {
                    replyErr("MCP extension is not initialized yet");
                    return;
                }

                const action = req.action === "reload" ? "reload" : "status";
                const result = action === "reload" ? await bridge.reload() : bridge.status();
                replyOk(result);
                return;
            }

            if (req.command === "abort") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }
                latestCtx.abort();
                replyOk();
                // Push a heartbeat immediately so the web UI updates active state quickly.
                forwardEvent(buildHeartbeat());
                return;
            }

            if (req.command === "set_model") {
                await setModelFromWeb(req.provider, req.modelId);
                replyOk();
                return;
            }

            if (req.command === "cycle_model") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }
                // Naive implementation: pick the next configured model after the current one.
                const models = getConfiguredModels(latestCtx);
                const state = buildSessionState();
                const currentKey = state?.model ? `${(state.model as any).provider}/${(state.model as any).id}` : null;
                const idx = currentKey ? models.findIndex((m) => `${m.provider}/${m.id}` === currentKey) : -1;
                const next = models.length > 0 ? models[(idx + 1 + models.length) % models.length] : null;
                if (!next) {
                    replyOk(null);
                    return;
                }
                await setModelFromWeb(next.provider, next.id);
                replyOk(next);
                return;
            }

            if (req.command === "get_available_models") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }
                replyOk({ models: getConfiguredModels(latestCtx) });
                return;
            }

            if (req.command === "set_thinking_level") {
                const level = String((req as any).level ?? "").trim();
                if (!level) {
                    replyErr("Missing level");
                    return;
                }
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }
                const api = pi as any;
                if (typeof api.setThinkingLevel !== "function" || typeof api.getThinkingLevel !== "function") {
                    replyErr("Thinking level controls are not available in this pi version");
                    return;
                }
                api.setThinkingLevel(level);
                replyOk({ thinkingLevel: api.getThinkingLevel() });
                forwardEvent({ type: "session_active", state: buildSessionState() });
                return;
            }

            if (req.command === "cycle_thinking_level") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }
                const api = pi as any;
                if (typeof api.setThinkingLevel !== "function" || typeof api.getThinkingLevel !== "function") {
                    replyErr("Thinking level controls are not available in this pi version");
                    return;
                }

                // No cycleThinkingLevel API exists, so we cycle manually.
                const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
                const current = String(api.getThinkingLevel() ?? "off");
                const startIdx = LEVELS.indexOf(current);

                let appliedLevel = current;
                for (let i = 1; i <= LEVELS.length; i++) {
                    const candidate = LEVELS[((startIdx >= 0 ? startIdx : 0) + i) % LEVELS.length];
                    api.setThinkingLevel(candidate);
                    appliedLevel = String(api.getThinkingLevel() ?? candidate);
                    // If clamping kept the same level, keep looking for the next distinct one.
                    if (appliedLevel !== current) break;
                }

                replyOk({ thinkingLevel: appliedLevel });
                forwardEvent({ type: "session_active", state: buildSessionState() });
                return;
            }

            if (req.command === "set_steering_mode") {
                replyErr("set_steering_mode is not supported by the PizzaPi runner yet");
                return;
            }

            if (req.command === "set_follow_up_mode") {
                replyErr("set_follow_up_mode is not supported by the PizzaPi runner yet");
                return;
            }

            if (req.command === "compact") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }
                // ctx.compact() is fire-and-forget; wrap in a promise for request/response semantics.
                const result = await new Promise<unknown>((resolve, reject) => {
                    latestCtx!.compact({
                        customInstructions: req.customInstructions,
                        onComplete: (r) => resolve(r),
                        onError: (err) => reject(err),
                    });
                });
                replyOk(result ?? null);
                forwardEvent({ type: "session_active", state: buildSessionState() });
                return;
            }

            if (req.command === "set_session_name") {
                if (typeof pi.setSessionName !== "function") {
                    replyErr("setSessionName is not available in this pi version");
                    return;
                }
                await pi.setSessionName(req.name);

                markSessionNameBroadcasted();
                const state = buildSessionState();
                replyOk({ sessionName: state?.sessionName ?? null });
                forwardEvent({ type: "session_active", state });
                forwardEvent(buildHeartbeat());
                return;
            }

            if (req.command === "get_last_assistant_text") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }
                const { messages } = buildSessionContext(
                    latestCtx.sessionManager.getEntries(),
                    latestCtx.sessionManager.getLeafId(),
                );
                const lastAssistant = [...messages].reverse().find((m: any) => m?.role === "assistant");
                const content = (lastAssistant as any)?.content;
                const text =
                    typeof content === "string"
                        ? content
                        : Array.isArray(content)
                          ? content
                                .filter((c: any) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
                                .map((c: any) => c.text)
                                .join("")
                          : null;
                replyOk({ text });
                return;
            }

            if (req.command === "list_resume_sessions") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }

                const sessions = await listSessionsForResume(latestCtx);
                const currentPath = latestCtx.sessionManager.getSessionFile();
                const candidates = sessions.filter((session) => session.path !== currentPath).map(toResumeSessionSummary);

                replyOk({
                    currentPath: currentPath ?? null,
                    sessions: candidates,
                });
                return;
            }

            if (req.command === "resume_session") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }

                if (typeof (pi as any).switchSession !== "function") {
                    replyErr("switchSession is not available in this pi version");
                    return;
                }

                const sessions = await listSessionsForResume(latestCtx);
                const currentPath = latestCtx.sessionManager.getSessionFile();
                const target = req.sessionPath
                    ? sessions.find((session) => session.path === req.sessionPath) ?? null
                    : pickResumeSession(sessions, currentPath, req.query);

                if (!target || target.path === currentPath) {
                    replyErr("No other sessions found to resume");
                    return;
                }

                try {
                    const result = await (pi as any).switchSession(target.path);
                    if (result?.cancelled) {
                        replyErr("Resume was cancelled");
                        return;
                    }
                } catch (e) {
                    replyErr(e instanceof Error ? e.message : String(e));
                    return;
                }

                replyOk({ session: toResumeSessionSummary(target) });
                forwardEvent({ type: "session_active", state: buildSessionState() });
                forwardEvent(buildHeartbeat());
                return;
            }

            if (req.command === "new_session") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }

                try {
                    // Uses patched pi.newSession() which delegates to
                    // AgentSession.newSession() — resets agent state, creates
                    // a new session file, and fires session lifecycle events.
                    const result = await (pi as any).newSession();
                    if (result?.cancelled) {
                        replyErr("New session was cancelled");
                        return;
                    }
                } catch (e) {
                    replyErr(e instanceof Error ? e.message : String(e));
                    return;
                }

                replyOk();
                forwardEvent({ type: "session_active", state: buildSessionState() });
                return;
            }

            if (req.command === "end_session") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }

                replyOk();
                shuttingDown = true;
                // Brief delay to ensure the response is flushed to the relay/web client
                setTimeout(() => {
                    latestCtx?.shutdown();
                }, 100);
                return;
            }

            if (req.command === "export_html") {
                replyErr("export_html is not implemented for remote exec yet");
                return;
            }

            if (req.command === "restart") {
                replyOk();
                // Brief delay to ensure the response is flushed to the relay/web client
                setTimeout(() => {
                    // When running as a runner-spawned worker, signal the daemon to
                    // re-spawn us (exit code 43) so it can send a fresh session_ready
                    // and preserve the runner→session link.
                    if (process.env.PIZZAPI_RUNNER_USAGE_CACHE_PATH) {
                        process.exit(43);
                        return;
                    }
                    // Standalone: self-fork as before.
                    const child = spawn(process.execPath, process.argv.slice(1), {
                        detached: true,
                        stdio: "inherit",
                        env: process.env,
                    });
                    child.unref();
                    process.exit(0);
                }, 100);
                return;
            }

            replyErr(`Unknown exec command: ${String((req as any).command)}`);
        } catch (e) {
            replyErr(e instanceof Error ? e.message : String(e));
        }
    }

    async function setModelFromWeb(provider: string, modelId: string) {
        if (!latestCtx) return;

        const model = latestCtx.modelRegistry.find(provider, modelId);
        if (!model) {
            forwardEvent({
                type: "model_set_result",
                ok: false,
                provider,
                modelId,
                message: "Model is not configured for this session.",
            });
            return;
        }

        try {
            // pi.setModel() will emit a model_select event on success.
            // We only push a full session_active snapshot if the selection succeeded,
            // to avoid the UI temporarily seeing a "stale" model in session_active.
            const ok = await pi.setModel(model);
            forwardEvent({
                type: "model_set_result",
                ok,
                provider,
                modelId,
                message: ok ? undefined : "Model selected, but no valid credentials were found.",
            });
            if (ok) {
                forwardEvent({ type: "session_active", state: buildSessionState() });
            }
        } catch (error) {
            forwardEvent({
                type: "model_set_result",
                ok: false,
                provider,
                modelId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    function setRelayStatus(text?: string) {
        if (!latestCtx) return;
        latestCtx.ui.setStatus(RELAY_STATUS_KEY, text);
    }

    function disconnectedStatusText(): string | undefined {
        if (isDisabled()) return undefined;
        return apiKey() ? "Disconnected from Relay" : undefined;
    }

    function consumePendingAskUserQuestionFromWeb(text: string): boolean {
        if (!pendingAskUserQuestion) return false;
        const answer = text.trim();
        if (!answer) return true;

        const pending = pendingAskUserQuestion;
        pendingAskUserQuestion = null;
        pending.resolve(answer);
        setRelayStatus(relay ? "Connected to Relay" : disconnectedStatusText());
        return true;
    }

    function cancelPendingAskUserQuestion() {
        if (!pendingAskUserQuestion) return;
        const pending = pendingAskUserQuestion;
        pendingAskUserQuestion = null;
        pending.resolve(null);
        setRelayStatus(relay ? "Connected to Relay" : disconnectedStatusText());
    }

    async function askUserQuestion(
        toolCallId: string,
        params: AskUserQuestionParams,
        signal: AbortSignal | undefined,
        ctx: ExtensionContext,
    ): Promise<{ answer: string | null; source: "tui" | "web" | null }> {
        const canAskViaWeb = !!relay && !!sioSocket?.connected;
        const canAskViaTui = ctx.hasUI;

        if (!canAskViaWeb && !canAskViaTui) {
            return { answer: null, source: null };
        }

        const localAbort = new AbortController();

        return await new Promise((resolve) => {
            let finished = false;
            let localDone = !canAskViaTui;
            let webDone = !canAskViaWeb;

            const onAbort = () => finish(null, null);

            const maybeFinishCancelled = () => {
                if (localDone && webDone) finish(null, null);
            };

            const finish = (answer: string | null, source: "tui" | "web" | null) => {
                if (finished) return;
                finished = true;

                if (pendingAskUserQuestion?.toolCallId === toolCallId) {
                    pendingAskUserQuestion = null;
                }

                localAbort.abort();
                if (signal) signal.removeEventListener("abort", onAbort);
                setRelayStatus(relay ? "Connected to Relay" : disconnectedStatusText());
                resolve({ answer, source });
            };

            if (signal?.aborted) {
                finish(null, null);
                return;
            }

            if (signal) {
                signal.addEventListener("abort", onAbort, { once: true });
            }

            if (canAskViaWeb) {
                pendingAskUserQuestion = {
                    toolCallId,
                    question: params.question,
                    options: params.options,
                    resolve: (answer) => {
                        webDone = true;
                        if (answer) {
                            finish(answer, "web");
                        } else {
                            maybeFinishCancelled();
                        }
                    },
                };
                setRelayStatus("Waiting for AskUserQuestion answer");
            }

            if (canAskViaTui) {
                // If options are provided, format them into the question for the TUI
                // (until we have a proper select UI method).
                let displayQuestion = params.question;
                if (params.options && params.options.length > 0) {
                    displayQuestion += ` (Options: ${params.options.join(", ")})`;
                }
                
                void ctx.ui
                    .input(displayQuestion, params.placeholder, { signal: localAbort.signal })
                    .then((value) => {
                        localDone = true;
                        const answer = value?.trim();
                        if (answer) {
                            finish(answer, "tui");
                        } else {
                            maybeFinishCancelled();
                        }
                    })
                    .catch(() => {
                        localDone = true;
                        maybeFinishCancelled();
                    });
            }

            maybeFinishCancelled();
        });
    }

    function sanitizeStatusText(text: string): string {
        return text
            .replace(/\x1B\[[0-9;]*m/g, "")
            .replace(/[\r\n\t]/g, " ")
            .replace(/ +/g, " ")
            .trim();
    }

    function formatTokens(count: number): string {
        if (count < 1000) return count.toString();
        if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
        if (count < 1000000) return `${Math.round(count / 1000)}k`;
        if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
        return `${Math.round(count / 1000000)}M`;
    }

    function truncateEnd(text: string, width: number): string {
        if (width <= 0) return "";
        if (text.length <= width) return text;
        if (width <= 3) return text.slice(0, width);
        return `${text.slice(0, width - 3)}...`;
    }

    function truncateMiddle(text: string, width: number): string {
        if (width <= 0) return "";
        if (text.length <= width) return text;
        if (width <= 5) return truncateEnd(text, width);
        const half = Math.floor((width - 3) / 2);
        const start = text.slice(0, half);
        const end = text.slice(-(width - 3 - half));
        return `${start}...${end}`;
    }

    function layoutLeftRight(
        left: string,
        right: string,
        width: number,
        truncateLeft: (text: string, width: number) => string,
    ): { left: string; pad: string; right: string } {
        if (width <= 0) return { left: "", pad: "", right: "" };
        const safeRight = truncateEnd(right, width);
        if (!safeRight) return { left: truncateLeft(left, width), pad: "", right: "" };
        if (safeRight.length + 2 >= width) return { left: "", pad: "", right: safeRight };

        const leftWidth = width - safeRight.length - 2;
        const safeLeft = truncateLeft(left, leftWidth);
        const pad = " ".repeat(Math.max(width - safeLeft.length - safeRight.length, 2));
        return { left: safeLeft, pad, right: safeRight };
    }

    function installFooter(ctx: ExtensionContext) {
        ctx.ui.setFooter((tui, theme, footerData) => {
            const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

            return {
                dispose: unsubscribe,
                invalidate() {},
                render(width: number): string[] {
                    const activeCtx = latestCtx ?? ctx;

                    let totalInput = 0;
                    let totalOutput = 0;
                    let totalCacheRead = 0;
                    let totalCacheWrite = 0;
                    let totalCost = 0;
                    for (const entry of activeCtx.sessionManager.getEntries()) {
                        if (entry.type === "message" && entry.message.role === "assistant") {
                            totalInput += entry.message.usage.input;
                            totalOutput += entry.message.usage.output;
                            totalCacheRead += entry.message.usage.cacheRead;
                            totalCacheWrite += entry.message.usage.cacheWrite;
                            totalCost += entry.message.usage.cost.total;
                        }
                    }

                    const contextUsage = activeCtx.getContextUsage();
                    const contextWindow = contextUsage?.contextWindow ?? activeCtx.model?.contextWindow ?? 0;
                    const contextPart =
                        contextUsage?.percent === null
                            ? `?/${formatTokens(contextWindow)} (auto)`
                            : `${(contextUsage?.percent ?? 0).toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;

                    let pwd = activeCtx.cwd;
                    const home = process.env.HOME || process.env.USERPROFILE;
                    if (home && pwd.startsWith(home)) {
                        pwd = `~${pwd.slice(home.length)}`;
                    }

                    const branch = footerData.getGitBranch();
                    if (branch) {
                        pwd = `${pwd} (${branch})`;
                    }

                    const sessionName = activeCtx.sessionManager.getSessionName();
                    if (sessionName) {
                        pwd = `${pwd} • ${sessionName}`;
                    }

                    const statsParts: string[] = [];
                    if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
                    if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
                    if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
                    if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
                    if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);
                    statsParts.push(contextPart);

                    const thinkingLevel = getCurrentThinkingLevel(activeCtx);
                    const modelName = activeCtx.model?.id ?? "no-model";
                    let modelText =
                        activeCtx.model?.reasoning && thinkingLevel
                            ? thinkingLevel === "off"
                                ? `${modelName} • thinking off`
                                : `${modelName} • ${thinkingLevel}`
                            : modelName;

                    if (footerData.getAvailableProviderCount() > 1 && activeCtx.model) {
                        modelText = `(${activeCtx.model.provider}) ${modelText}`;
                    }

                    const extensionStatuses = footerData.getExtensionStatuses();
                    const relayStatus = sanitizeStatusText(extensionStatuses.get(RELAY_STATUS_KEY) ?? "");

                    const statsText = statsParts.join(" ");
                    const modelBadge = `• ${modelText}`;
                    // Make sure the footer always consumes the full available width.
                    // Some terminals/fonts can make the right side look "floating" if the
                    // concatenated string ends up shorter than `width`.
                    const locationLine = layoutLeftRight(pwd, modelBadge, width, truncateMiddle);
                    const statsLine = layoutLeftRight(statsText, relayStatus, width, truncateEnd);
                    const relayStatusColor = relayStatus.toLowerCase().includes("disconnected") ? "error" : "success";

                    const line1Raw = locationLine.left + locationLine.pad + locationLine.right;
                    const line2Raw = statsLine.left + statsLine.pad + statsLine.right;

                    const line1Pad = " ".repeat(Math.max(0, width - line1Raw.length));
                    const line2Pad = " ".repeat(Math.max(0, width - line2Raw.length));

                    return [
                        theme.fg("dim", locationLine.left) + locationLine.pad + theme.fg("dim", locationLine.right) + line1Pad,
                        theme.fg("dim", statsLine.left) + statsLine.pad + theme.fg(relayStatusColor as any, statsLine.right) + line2Pad,
                    ];
                },
            };
        });
    }

    // ── Socket.IO connection ─────────────────────────────────────────────────

    function apiKey(): string | undefined {
        return (
            process.env.PIZZAPI_API_KEY ??
            process.env.PIZZAPI_API_TOKEN ??
            loadConfig(process.cwd()).apiKey
        );
    }

    /**
     * Derive the Socket.IO base URL from the relay URL.
     * Socket.IO now runs on the same port as the REST API.
     */
    function socketIoUrl(): string {
        // Prefer explicit env var if set.
        const explicit = process.env.PIZZAPI_SOCKETIO_URL;
        if (explicit && explicit.trim()) return explicit.trim().replace(/\/$/, "");

        // Derive from relay URL: ws→http, wss→https (same port).
        const base = relayUrl();
        return base
            .replace(/^ws:/, "http:")
            .replace(/^wss:/, "https:")
            .replace(/\/$/, "");
    }

    function connect() {
        if (isDisabled() || shuttingDown) {
            setRelayStatus(disconnectedStatusText());
            return;
        }

        const key = apiKey();
        if (!key) {
            setRelayStatus(disconnectedStatusText());
            return;
        }

        // Tear down any previous socket before creating a new one.
        if (sioSocket) {
            sioSocket.removeAllListeners();
            sioSocket.disconnect();
            sioSocket = null;
        }

        const sioUrl = socketIoUrl();

        const sock: Socket<RelayServerToClientEvents, RelayClientToServerEvents> = io(
            sioUrl + "/relay",
            {
                auth: { apiKey: key },
                transports: ["websocket"],
                reconnection: true,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 30_000,
            },
        );
        sioSocket = sock;

        // ── Connection lifecycle ──────────────────────────────────────────

        sock.on("connect", () => {
            sock.emit("register", {
                sessionId: relaySessionId,
                cwd: process.cwd(),
                ephemeral: true,
                collabMode: true,
                sessionName: getCurrentSessionName(latestCtx) ?? undefined,
            });
        });

        sock.on("registered", (data) => {
            relaySessionId = data.sessionId;
            relay = {
                sessionId: data.sessionId,
                token: data.token,
                shareUrl: data.shareUrl,
                seq: 0,
                ackedSeq: 0,
            };
            setRelayStatus("Connected to Relay");

            // Wire up the inter-session message bus now that we have a relay connection.
            messageBus.setOwnSessionId(relaySessionId);
            messageBus.setSendFn((targetSessionId: string, message: string) => {
                if (!relay || !sioSocket?.connected) return false;
                sioSocket.emit("session_message", {
                    token: relay.token,
                    targetSessionId,
                    message,
                });
                return true;
            });

            forwardEvent({ type: "session_active", state: buildSessionState() });
            void refreshAllUsage();
            startHeartbeat();
        });

        // ── Incoming events from server ───────────────────────────────────

        sock.on("event_ack", (data) => {
            // Relay sends cumulative acks; keep only the highest seq we've seen.
            if (relay && typeof data.seq === "number") {
                relay.ackedSeq = Math.max(relay.ackedSeq, data.seq);
            }
        });

        sock.on("connected", () => {
            // A new viewer connected (web UI). Send capability snapshot.
            forwardEvent(buildCapabilitiesState());
            // Also send a fresh session snapshot so the viewer can populate models/messages.
            forwardEvent({ type: "session_active", state: buildSessionState() });
        });

        sock.on("input", (data) => {
            const inputText = data.text;
            if (consumePendingAskUserQuestionFromWeb(inputText)) {
                return;
            }

            const attachments = normalizeRemoteInputAttachments(data.attachments);
            const deliverAs = data.deliverAs === "followUp" ? "followUp" as const
                : data.deliverAs === "steer" ? "steer" as const
                : undefined;
            void (async () => {
                const message = await buildUserMessageFromRemoteInput(inputText, attachments);
                pi.sendUserMessage(message as any, deliverAs ? { deliverAs } : undefined);
            })();
        });

        sock.on("exec", (data) => {
            if (typeof data.id === "string" && typeof data.command === "string") {
                void handleExecFromWeb(data as any);
            }
        });

        sock.on("model_set", (data) => {
            void setModelFromWeb(data.provider, data.modelId);
        });

        sock.on("session_message", (data) => {
            messageBus.receive({
                fromSessionId: data.fromSessionId,
                message: data.message,
                ts: typeof data.ts === "string" ? data.ts : new Date().toISOString(),
            });
        });

        sock.on("session_expired", (data) => {
            // Session was expired by the server — stop retrying.
            shuttingDown = true;
            relay = null;
            setRelayStatus("Session expired");
        });

        sock.on("error", (data) => {
            // Server-side error — log but don't tear down (socket.io will reconnect).
            setRelayStatus(`Relay error: ${data.message}`);
        });

        // ── Disconnect / reconnect ────────────────────────────────────────

        sock.on("disconnect", (_reason) => {
            relay = null;
            cancelPendingAskUserQuestion();
            setRelayStatus(disconnectedStatusText());
        });

        // socket.io fires "connect" again on reconnect, which triggers
        // re-registration automatically via the handler above.
    }

    function disconnect() {
        stopHeartbeat();
        cancelPendingAskUserQuestion();
        messageBus.setSendFn(null);
        if (sioSocket) {
            if (relay && sioSocket.connected) {
                sioSocket.emit("session_end", { sessionId: relay.sessionId, token: relay.token });
            }
            sioSocket.removeAllListeners();
            sioSocket.disconnect();
            sioSocket = null;
        }
        relay = null;
        setRelayStatus(disconnectedStatusText());
    }

    // ── Auto-connect on session start ─────────────────────────────────────────

    pi.on("session_start", (_event, ctx) => {
        latestCtx = ctx;
        sessionStartedAt = Date.now();
        isAgentActive = false;
        installFooter(ctx);
        startSessionNameSync();
        if (isDisabled()) {
            setRelayStatus(disconnectedStatusText());
            return;
        }
        connect();
    });

    pi.on("session_switch", (_event, ctx) => {
        latestCtx = ctx;
        sessionStartedAt = Date.now();
        isAgentActive = false;
        installFooter(ctx);
        startSessionNameSync();
        setRelayStatus(
            pendingAskUserQuestion
                ? "Waiting for AskUserQuestion answer"
                : relay
                  ? "Connected to Relay"
                  : disconnectedStatusText(),
        );
        forwardEvent({ type: "session_active", state: buildSessionState() });
        forwardEvent(buildHeartbeat());
    });

    pi.on("session_shutdown", () => {
        shuttingDown = true;
        stopHeartbeat();
        stopSessionNameSync();
        _cliErrorForwarder = null;
        disconnect();
    });

    // ── AskUserQuestion tool ──────────────────────────────────────────────────

    pi.registerTool({
        name: ASK_USER_TOOL_NAME,
        label: "Ask User Question",
        description:
            "Ask the user a clarification question and wait for a response. Use this when you must collect user input before continuing.",
        parameters: {
            type: "object",
            properties: {
                question: {
                    type: "string",
                    description: "The question to ask the user.",
                },
                placeholder: {
                    type: "string",
                    description: "Optional placeholder hint for the answer input.",
                },
                options: {
                    type: "array",
                    items: { type: "string" },
                    description: "Predefined choices for the user to select from. Always include a \"Type your own\" option as the last choice to allow free-form input.",
                },
            },
            required: ["question", "options"],
            additionalProperties: false,
        } as any,
        async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
            if (pendingAskUserQuestion && pendingAskUserQuestion.toolCallId !== toolCallId) {
                return {
                    content: [{ type: "text", text: "A different AskUserQuestion prompt is already pending." }],
                    details: {
                        question: pendingAskUserQuestion.question,
                        options: pendingAskUserQuestion.options,
                        answer: null,
                        source: null,
                        cancelled: true,
                    } satisfies AskUserQuestionDetails,
                };
            }

            const params = (rawParams ?? {}) as AskUserQuestionParams;
            const question = params.question?.trim();

            if (!question) {
                return {
                    content: [{ type: "text", text: "AskUserQuestion requires a non-empty question." }],
                    details: {
                        question: "",
                        options: params.options,
                        answer: null,
                        source: null,
                        cancelled: true,
                    } satisfies AskUserQuestionDetails,
                };
            }

            onUpdate?.({
                content: [{ type: "text", text: `Waiting for answer: ${question}` }],
                details: {
                    question,
                    options: params.options,
                    answer: null,
                    source: null,
                    cancelled: false,
                    status: "waiting",
                } satisfies AskUserQuestionDetails,
            });

            const result = await askUserQuestion(
                toolCallId,
                { question, placeholder: params.placeholder, options: params.options },
                signal,
                ctx,
            );

            if (!result.answer) {
                return {
                    content: [{ type: "text", text: "User did not provide an answer." }],
                    details: {
                        question,
                        options: params.options,
                        answer: null,
                        source: null,
                        cancelled: true,
                    } satisfies AskUserQuestionDetails,
                };
            }

            onUpdate?.({
                content: [{ type: "text", text: `Answer received: ${result.answer}` }],
                details: {
                    question,
                    options: params.options,
                    answer: result.answer,
                    source: result.source,
                    cancelled: false,
                    status: "answered",
                } satisfies AskUserQuestionDetails,
            });

            return {
                content: [{ type: "text", text: `User answered: ${result.answer}` }],
                details: {
                    question,
                    options: params.options,
                    answer: result.answer,
                    source: result.source,
                    cancelled: false,
                } satisfies AskUserQuestionDetails,
            };
        },
    });

    // ── /remote command ───────────────────────────────────────────────────────

    pi.registerCommand("remote", {
        description: "Show relay share URL, or: /remote stop | /remote reconnect",
        getArgumentCompletions: (prefix) => {
            const options = ["stop", "reconnect"];
            const filtered = options.filter((o) => o.startsWith(prefix.trim().toLowerCase()));
            return filtered.length ? filtered.map((o) => ({ value: o, label: o })) : null;
        },
        handler: async (args, ctx) => {
            const arg = args.trim().toLowerCase();

            if (arg === "stop") {
                disconnect();
                ctx.ui.notify("Disconnected from relay.");
                return;
            }

            if (arg === "reconnect") {
                disconnect();
                shuttingDown = false;
                connect();
                ctx.ui.notify("Reconnecting to relay…");
                return;
            }

            // Default: show status
            if (relay) {
                ctx.ui.notify(`Connected to Relay\nShare URL: ${relay.shareUrl}`);
            } else {
                const url = isDisabled() ? "(disabled — set PIZZAPI_RELAY_URL to enable)" : relayUrl();
                ctx.ui.notify(`Not connected to relay.\nRelay: ${url}\nUse /remote reconnect to retry.`);
            }
        },
    });

    // ── Forward agent events to relay ─────────────────────────────────────────

    pi.on("agent_start", (event) => {
        isAgentActive = true;
        forwardEvent(event);
        // Push an immediate heartbeat so viewers see "active" without waiting 10s.
        forwardEvent(buildHeartbeat());
    });
    pi.on("agent_end", (event) => {
        isAgentActive = false;
        forwardEvent(event);
        // Push a heartbeat immediately so viewers see "idle" after the turn.
        forwardEvent(buildHeartbeat());
    });
    pi.on("turn_start", (event) => forwardEvent(event));
    pi.on("turn_end", (event) => forwardEvent(event));
    pi.on("message_start", (event) => forwardEvent(event));
    pi.on("message_update", (event) => forwardEvent(event));
    pi.on("message_end", (event) => forwardEvent(event));
    pi.on("tool_execution_start", (event) => forwardEvent(event));
    pi.on("tool_execution_update", (event) => forwardEvent(event));
    pi.on("tool_execution_end", (event) => forwardEvent(event));
    pi.on("model_select", (event) => {
        forwardEvent(event);
        forwardEvent({ type: "session_active", state: buildSessionState() });
    });
};
