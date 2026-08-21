/**
 * Built-in Time service — scheduled follow-ups and adaptive time sigils.
 *
 * The trigger types let an agent schedule a follow-up and end its turn instead
 * of blocking on something like `sleep`. Fires are delivered only to the
 * session that owns the subscription, and one-shot subscriptions
 * (time:timer_fired, time:at) are automatically removed after delivery.
 *
 * Triggers:
 *   time:timer_fired  — one-shot delay timer ("check back in 10m")
 *   time:at            — fire at a specific absolute time
 *   time:cron          — periodic on a cron schedule
 *
 * Sigils:
 *   [[time:2026-03-30T08:00Z]]  — adaptive relative time ("5 min ago", "In 2 hours")
 *   [[countdown:5m]]            — live countdown timer ("T-4:32", "Done!")
 *
 * No panel — the service runs a minimal HTTP server for sigil resolve endpoints only.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Socket } from "socket.io-client";
// Bun's Server generic requires a WebSocketData type param; we don't use WS so `unknown` suffices.
type BunServer = import("bun").Server<unknown>;
import type { ReconcileOptions, ServiceHandler, ServiceInitOptions } from "../service-handler.js";
import type { ServiceTriggerDef, ServiceSigilDef, TriggerSubscriptionEntry } from "@pizzapi/protocol";
import {
    parseDuration,
    formatDuration,
    parseTimeString,
    formatRelativeTime,
    formatCountdown,
    parseCron,
    nextCronTime,
} from "./time-utils.js";
import { logInfo, logWarn, logError } from "../logger.js";
import { normalizeLoopbackHost } from "../../relay-url.js";

/** Largest delay setTimeout honors; anything above overflows and fires immediately. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Bound on a single relay delivery attempt; a timeout is treated as a retry. */
const DELIVERY_TIMEOUT_MS = 15_000;

/**
 * Backoff for retrying a failed delivery: 1m, 5m, 15m, then 30m cap.
 * A schedule must not be lost just because its owning session is offline, so
 * a transient delivery failure re-arms the fire rather than dropping it.
 */
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;

/** How many times to retry handing a recurring schedule to its new owner. */
const RESUBSCRIBE_ATTEMPTS = 3;

/** Outcome of a trigger delivery attempt. */
type DeliveryResult = "delivered" | "retry" | "gone";

/**
 * Initial prompt for a replacement session that takes over a schedule whose
 * owning session no longer exists.
 */
function buildReplacementPrompt(schedule: string, label: string | undefined, message: string | undefined, recurring = false): string {
    const header = `You are handling a scheduled follow-up (${schedule}${label ? `, "${label}"` : ""}). ` +
        `The session that created this schedule no longer exists, so it has been ${recurring ? "restarted in this new session — the recurring schedule now belongs to this session" : "handed to this new session"}.`;
    return message ? `${header}\n\nInstruction: ${message}` : `${header}\n\nNo instruction was attached; review the schedule context and act accordingly.`;
}

/** Durable per-cron state persisted across runner restarts. */
interface CronState {
    nextFireAt: number;
    iteration: number;
    /** Timer entries only: the duration param the fireAt was computed from. */
    duration?: string;
}

// ── Relay helpers ────────────────────────────────────────────────────────────

function resolveRelayUrl(): string {
    const home = process.env.HOME || homedir();
    let raw = process.env.PIZZAPI_RELAY_URL?.trim();
    if (!raw) {
        try {
            const cfg = JSON.parse(readFileSync(join(home, ".pizzapi", "config.json"), "utf-8"));
            if (typeof cfg?.relayUrl === "string" && cfg.relayUrl !== "off") raw = cfg.relayUrl.trim();
        } catch { /* ignore */ }
    }
    raw = normalizeLoopbackHost(raw || "http://localhost:7492");
    if (raw.startsWith("ws://")) return raw.replace(/^ws:/, "http:").replace(/\/$/, "");
    if (raw.startsWith("wss://")) return raw.replace(/^wss:/, "https:").replace(/\/$/, "");
    return raw.replace(/\/$/, "");
}

function getApiKey(): string | null {
    const env = process.env.PIZZAPI_RUNNER_API_KEY ?? process.env.PIZZAPI_API_KEY ?? process.env.PIZZAPI_API_TOKEN;
    if (env) return env;
    // The daemon itself accepts its apiKey from ~/.pizzapi/config.json (env
    // vars are optional) — a runner configured that way must still be able to
    // deliver schedule fires over HTTP, or every timer silently retries forever.
    try {
        const cfg = JSON.parse(readFileSync(join(process.env.HOME || homedir(), ".pizzapi", "config.json"), "utf-8"));
        if (typeof cfg?.apiKey === "string" && cfg.apiKey) return cfg.apiKey;
    } catch { /* ignore */ }
    return null;
}

/** This runner's stable identity from ~/.pizzapi/runner.json (null when unavailable). */
function getOwnRunnerId(): string | null {
    const statePath = process.env.PIZZAPI_RUNNER_STATE_PATH
        ?? join(process.env.HOME || homedir(), ".pizzapi", "runner.json");
    try {
        const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
        return typeof parsed?.runnerId === "string" && parsed.runnerId ? parsed.runnerId : null;
    } catch {
        return null;
    }
}

/** Optional cwd captured into subscription params at subscribe time (`_cwd`). */
function cwdFromParams(params: unknown): string | undefined {
    const cwd = (params as Record<string, unknown> | null | undefined)?._cwd;
    return typeof cwd === "string" && cwd ? cwd : undefined;
}

/**
 * Optional transcript path captured at subscribe time (`_resumePath`).
 * A replacement session resumes it, so a woken schedule keeps the context of
 * the conversation that scheduled it. Resume appends to the same file, so this
 * stays valid across repeated cron migrations.
 */
function resumePathFromParams(params: unknown): string | undefined {
    const path = (params as Record<string, unknown> | null | undefined)?._resumePath;
    return typeof path === "string" && path ? path : undefined;
}

// ── Timer state ──────────────────────────────────────────────────────────────

interface TimerEntry {
    /** Stable subscription identity */
    subscriptionId: string;
    /** Timer handle for clearTimeout */
    handle: ReturnType<typeof setTimeout>;
    /** Absolute fire time in ms */
    fireAt: number;
    /** Session that owns this timer */
    sessionId: string;
    /** Trigger type */
    triggerType: string;
    /** Label from subscription params */
    label?: string;
}

interface CronEntry {
    /** Stable subscription identity */
    subscriptionId: string;
    /** Interval handle for the cron checker */
    handle: ReturnType<typeof setInterval>;
    /** Parsed cron expression */
    cron: ReturnType<typeof parseCron>;
    /** Session that owns this cron */
    sessionId: string;
    /** Label from subscription params */
    label?: string;
    /** Next scheduled fire time */
    nextFireAt: number;
    /** True while a delivery attempt is in flight (prevents double-fire). */
    delivering: boolean;
    /** Consecutive failed delivery attempts, for backoff. */
    retryCount: number;
}

// ── Static definitions ───────────────────────────────────────────────────────

/** Trigger definitions advertised to agents. */
export const TIME_TRIGGER_DEFS: ServiceTriggerDef[] = [
    {
        type: "time:timer_fired",
        label: "Scheduled Follow-up",
        description: "Schedule a follow-up instead of blocking with `sleep`. Subscribe with a duration (e.g. \"10m\", \"1h30m\", \"30s\") and a `message` describing what to do, then end your turn — the trigger wakes the session when the time elapses. Fires once and the subscription is removed automatically.",
        schema: {
            type: "object",
            properties: {
                duration: { type: "string", description: "The original duration string" },
                durationMs: { type: "number", description: "Duration in milliseconds" },
                firedAt: { type: "string", description: "ISO timestamp when the timer fired" },
                label: { type: "string", description: "Optional label" },
                message: { type: "string", description: "The follow-up note provided at subscribe time" },
            },
        },
        params: [
            {
                name: "duration",
                label: "Duration",
                type: "string",
                description: "How long to wait (e.g. \"10m\", \"1h30m\", \"30s\")",
                required: true,
            },
            {
                name: "message",
                label: "Message",
                type: "string",
                description: "Note to your future self — what to do when this fires (e.g. \"Check if the build finished and report results\")",
                required: false,
            },
            {
                name: "label",
                label: "Label",
                type: "string",
                description: "Optional label for the timer",
                required: false,
            },
        ],
    },
    {
        type: "time:at",
        label: "Follow-up At Time",
        description: "Schedule a follow-up at a specific absolute time instead of waiting/polling. Supports ISO 8601 (\"2026-03-30T08:00:00Z\") and HH:MMUTC (\"14:30UTC\"). Subscribe with a `message`, end your turn, and the trigger wakes the session at the target time. Fires once and the subscription is removed automatically.",
        schema: {
            type: "object",
            properties: {
                at: { type: "string", description: "The target time (ISO 8601)" },
                firedAt: { type: "string", description: "ISO timestamp when the trigger fired" },
                label: { type: "string", description: "Optional label" },
                message: { type: "string", description: "The follow-up note provided at subscribe time" },
            },
        },
        params: [
            {
                name: "at",
                label: "Time",
                type: "string",
                description: "When to fire (ISO 8601 or HH:MMUTC)",
                required: true,
            },
            {
                name: "message",
                label: "Message",
                type: "string",
                description: "Note to your future self — what to do when this fires",
                required: false,
            },
            {
                name: "label",
                label: "Label",
                type: "string",
                description: "Optional label for the timer",
                required: false,
            },
        ],
    },
    {
        type: "time:cron",
        label: "Cron Schedule",
        description: "Recurring follow-up on a cron schedule. Standard 5-field format: minute hour day-of-month month day-of-week. Fields are matched in UTC, not local time — \"0 9 * * *\" means 09:00 UTC daily, so convert if you mean a local hour. Being UTC also means intervals are fixed and unaffected by daylight-saving changes. Delivered only to your session; unsubscribe when you no longer need it.",
        schema: {
            type: "object",
            properties: {
                cron: { type: "string", description: "The cron expression" },
                firedAt: { type: "string", description: "ISO timestamp when the trigger fired" },
                label: { type: "string", description: "Optional label" },
                message: { type: "string", description: "The follow-up note provided at subscribe time" },
                iteration: { type: "number", description: "How many times this cron has fired" },
            },
        },
        params: [
            {
                name: "cron",
                label: "Cron Expression",
                type: "string",
                description: "Standard 5-field cron, matched in UTC (e.g. \"*/30 * * * *\" for every 30 minutes; \"0 9 * * *\" is 09:00 UTC daily)",
                required: true,
            },
            {
                name: "message",
                label: "Message",
                type: "string",
                description: "Note to your future self — what to do on each fire",
                required: false,
            },
            {
                name: "label",
                label: "Label",
                type: "string",
                description: "Optional label for the schedule",
                required: false,
            },
        ],
    },
];

/** Sigil definitions advertised to the UI. */
export const TIME_SIGIL_DEFS: ServiceSigilDef[] = [
    {
        type: "time",
        label: "Time",
        icon: "clock",
        description: "An adaptive time reference. Shows relative time (\"5 min ago\", \"In 2 hours\") that updates live.",
        resolve: "/api/resolve/time/{id}",
        aliases: ["timestamp", "when", "at"],
    },
    {
        type: "countdown",
        label: "Countdown",
        icon: "timer",
        description: "A live countdown timer. Shows remaining time (\"T-4:32\") that ticks down every second.",
        resolve: "/api/resolve/countdown/{id}",
        aliases: ["timer"],
    },
];

// ── Service implementation ───────────────────────────────────────────────────

export class TimeService implements ServiceHandler {
    readonly id = "time";

    #server: BunServer | null = null;
    #socket: Socket | null = null;
    #timers = new Map<string, TimerEntry>();
    #crons = new Map<string, CronEntry>();
    #cronIterations = new Map<string, number>();
    /** True after dispose() — in-flight fires must not re-arm or spawn replacements. */
    #disposed = false;
    /** Lazily-loaded durable cron state, keyed by subscriptionId. */
    #cronState: Record<string, CronState> | null = null;

    constructor(
        private readonly retryBackoffMs: readonly number[] = RETRY_BACKOFF_MS,
        private readonly cronCheckIntervalMs: number = 30_000,
        private readonly deliveryTimeoutMs: number = DELIVERY_TIMEOUT_MS,
    ) {}

    /** Backoff delay for a failed delivery attempt, capped at the last entry. */
    #backoffDelay(attempt: number): number {
        return this.retryBackoffMs[Math.min(attempt, this.retryBackoffMs.length - 1)] ?? 30_000;
    }

    // ── Durable cron state ────────────────────────────────────────────────

    #stateFilePath(): string {
        return join(process.env.HOME || homedir(), ".pizzapi", "time-service-state.json");
    }

    #getCronState(): Record<string, CronState> {
        if (this.#cronState === null) {
            let state: Record<string, CronState> = {};
            const path = this.#stateFilePath();
            try {
                const raw = readFileSync(path, "utf-8");
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) state = parsed as Record<string, CronState>;
                } catch (err) {
                    // Corrupt JSON — quarantine instead of silently resetting so
                    // schedule state is recoverable by hand.
                    const quarantine = `${path}.corrupt-${Date.now()}`;
                    try {
                        renameSync(path, quarantine);
                        logWarn(`[time] corrupt state file quarantined to ${quarantine}: ${err}`);
                    } catch {
                        logWarn(`[time] corrupt state file (quarantine failed): ${err}`);
                    }
                }
            } catch {
                // missing file — start empty
            }
            this.#cronState = state;
        }
        return this.#cronState;
    }

    #saveCronState(): void {
        try {
            mkdirSync(join(process.env.HOME || homedir(), ".pizzapi"), { recursive: true });
            // Atomic temp-file + rename so a crash mid-write never leaves a
            // truncated/corrupt state file.
            const path = this.#stateFilePath();
            const tmp = `${path}.tmp-${process.pid}`;
            writeFileSync(tmp, JSON.stringify(this.#cronState ?? {}), "utf-8");
            renameSync(tmp, path);
        } catch (err) {
            logWarn(`[time] failed to persist cron state: ${err}`);
        }
    }

    // ── Durable one-shot timer state (absolute deadlines) ─────────────────

    #timerStateKey(subscriptionId: string): string {
        return `timer:${subscriptionId}`;
    }

    #persistTimer(subscriptionId: string, fireAt: number, duration: string): void {
        const state = this.#getCronState();
        state[this.#timerStateKey(subscriptionId)] = { nextFireAt: fireAt, iteration: 0, duration };
        this.#saveCronState();
    }

    #dropTimerState(subscriptionId: string): void {
        const state = this.#getCronState();
        const key = this.#timerStateKey(subscriptionId);
        if (key in state) {
            delete state[key];
            this.#saveCronState();
        }
    }

    /** Persisted absolute deadline for a timer, if the duration param is unchanged. */
    #persistedTimerFireAt(subscriptionId: string, duration: string): number | null {
        const entry = this.#getCronState()[this.#timerStateKey(subscriptionId)];
        if (!entry || entry.duration !== duration) return null;
        return typeof entry.nextFireAt === "number" ? entry.nextFireAt : null;
    }

    #persistCron(subscriptionId: string, nextFireAt: number, iteration: number): void {
        const state = this.#getCronState();
        state[subscriptionId] = { nextFireAt, iteration };
        this.#saveCronState();
    }

    #dropCronState(subscriptionId: string): void {
        const state = this.#getCronState();
        if (subscriptionId in state) {
            delete state[subscriptionId];
            this.#saveCronState();
        }
    }

    init(socket: Socket, { announceSigilServer }: ServiceInitOptions): void {
        this.#socket = socket;

        // Start HTTP server for sigil resolve endpoints
        this.#server = Bun.serve({
            port: 0,
            fetch: async (req) => {
                const url = new URL(req.url);
                const cors = { "Access-Control-Allow-Origin": "*" };

                // CORS preflight
                if (req.method === "OPTIONS") {
                    return new Response(null, {
                        status: 204,
                        headers: {
                            ...cors,
                            "Access-Control-Allow-Methods": "GET, OPTIONS",
                            "Access-Control-Allow-Headers": "*",
                        },
                    });
                }

                // Resolve [[time:id]]
                const timeMatch = url.pathname.match(/^\/api\/resolve\/time\/(.+)$/);
                if (timeMatch) {
                    const id = decodeURIComponent(timeMatch[1]);
                    return this.#resolveTime(id, cors);
                }

                // Resolve [[countdown:id]]
                const countdownMatch = url.pathname.match(/^\/api\/resolve\/countdown\/(.+)$/);
                if (countdownMatch) {
                    const id = decodeURIComponent(countdownMatch[1]);
                    return this.#resolveCountdown(id, cors);
                }

                return Response.json({ error: "Not found" }, { status: 404, headers: cors });
            },
        });

        // Announce port so the tunnel proxy can route sigil resolve requests.
        // Uses announceSigilServer (not announcePanel) so this service does not
        // appear as a UI panel — it only provides resolve endpoints.
        const port = this.#server.port;
        if (announceSigilServer && port) {
            announceSigilServer(port);
        }

        // Subscription changes are delivered via trigger_subscription_delta and
        // handled through reconcileSubscriptions() — no socket listener needed here.
        // (The legacy subscription_params_changed event has been removed from the server.)

        logInfo(`[time] service started, resolve server on port ${this.#server.port}`);
    }

    /**
     * Reconcile in-memory timer/cron state from either a full subscription snapshot
     * or a single live delta.
     *
     * For time:timer_fired and time:cron, the timer restarts from scratch (no elapsed
     * time is preserved across restarts). For time:at, the target time is absolute, so
     * the timer fires at the right time (or immediately if already past).
     *
     * Runtime entries are keyed by stable `subscriptionId`, not just session/type,
     * so multiple subscriptions of the same trigger type can coexist for a single
     * session without clobbering each other.
     */
    reconcileSubscriptions(subscriptions: TriggerSubscriptionEntry[], options: ReconcileOptions = {}): { applied: number; errors?: string[] } {
        const mode = options.mode ?? "snapshot";
        const action = options.action ?? "subscribe";

        // Only handle our trigger types
        const timeSubs = subscriptions.filter(
            (s) =>
                s.triggerType === "time:timer_fired" ||
                s.triggerType === "time:at" ||
                s.triggerType === "time:cron",
        );

        if (mode === "snapshot") {
            const snapshotKeys = new Set(timeSubs.map((s) => this.#runtimeKey(s)));

            for (const [key, timer] of this.#timers) {
                if (!snapshotKeys.has(key)) {
                    clearTimeout(timer.handle);
                    this.#timers.delete(key);
                    if (timer.triggerType === "time:timer_fired") this.#dropTimerState(timer.subscriptionId);
                    logInfo(`[time] reconcile: removed stale timer ${key}`);
                }
            }
            for (const [key, cron] of this.#crons) {
                if (!snapshotKeys.has(key)) {
                    clearInterval(cron.handle);
                    this.#crons.delete(key);
                    this.#cronIterations.delete(key);
                    this.#dropCronState(cron.subscriptionId);
                    logInfo(`[time] reconcile: removed stale cron ${key}`);
                }
            }

            // Prune persisted state for subscriptions that vanished while the
            // daemon was down (they were never in memory, so the loops above
            // can't see them).
            const snapshotSubIds = new Set(timeSubs.map((s) => s.subscriptionId ?? `${s.sessionId}\0${s.triggerType}`));
            const persisted = this.#getCronState();
            let pruned = false;
            for (const key of Object.keys(persisted)) {
                const subId = key.startsWith("timer:") ? key.slice("timer:".length) : key;
                if (!snapshotSubIds.has(subId)) {
                    delete persisted[key];
                    pruned = true;
                }
            }
            if (pruned) this.#saveCronState();
        }

        // Create/update/remove timers for the relevant subscriptions.
        let applied = 0;
        const errors: string[] = [];

        for (const sub of timeSubs) {
            try {
                this.#applySubscription(sub, mode === "delta" ? action : "subscribe");
                applied++;
            } catch (err) {
                const msg = `${sub.sessionId}/${sub.triggerType}: ${err instanceof Error ? err.message : String(err)}`;
                logWarn(`[time] reconcile error: ${msg}`);
                errors.push(msg);
            }
        }

        logInfo(`[time] reconciled ${applied}/${timeSubs.length} subscriptions from ${mode}${mode === "delta" ? ` (${action})` : ""}`);
        return { applied, ...(errors.length > 0 ? { errors } : {}) };
    }

    dispose(): void {
        this.#disposed = true;
        // Clear all timers
        for (const timer of this.#timers.values()) {
            clearTimeout(timer.handle);
        }
        this.#timers.clear();

        // Clear all crons
        for (const cron of this.#crons.values()) {
            clearInterval(cron.handle);
        }
        this.#crons.clear();
        this.#cronIterations.clear();
        this.#cronState = null;

        // No socket listener to remove — subscription changes come via reconcileSubscriptions().
        this.#socket = null;

        // Stop HTTP server
        if (this.#server) {
            this.#server.stop(true);
            this.#server = null;
        }

        logInfo("[time] service disposed");
    }

    // ── Sigil resolve handlers ───────────────────────────────────────────

    #resolveTime(id: string, cors: Record<string, string>): Response {
        const timestamp = parseTimeString(id);
        if (timestamp === null) {
            return Response.json(
                { error: `Cannot parse time: "${id}"` },
                { status: 400, headers: cors },
            );
        }

        const title = formatRelativeTime(timestamp);
        const iso = new Date(timestamp).toISOString();

        return Response.json({
            title,
            timestamp,
            iso,
            // The UI uses `_adaptive` as a signal to enable live-ticking
            _adaptive: "time",
            description: iso,
        }, { headers: cors });
    }

    #resolveCountdown(id: string, cors: Record<string, string>): Response {
        const now = Date.now();

        // Countdown id can be a duration ("5m") or absolute time
        let targetMs: number;
        const durationMs = parseDuration(id);
        if (durationMs !== null) {
            // Duration-based countdown: target is now + duration
            // We return the absolute target time so the UI can count down
            targetMs = now + durationMs;
        } else {
            const parsed = parseTimeString(id);
            if (parsed === null) {
                return Response.json(
                    { error: `Cannot parse countdown target: "${id}"` },
                    { status: 400, headers: cors },
                );
            }
            targetMs = parsed;
        }

        const title = formatCountdown(targetMs, now);

        return Response.json({
            title,
            timestamp: targetMs,
            // The UI uses `_adaptive` as a signal to enable live-ticking
            _adaptive: "countdown",
            description: `Counting down to ${new Date(targetMs).toISOString()}`,
        }, { headers: cors });
    }

    // ── Timer subscription handlers ──────────────────────────────────────

    #runtimeKey(sub: Pick<TriggerSubscriptionEntry, "subscriptionId" | "sessionId" | "triggerType">): string {
        const baseId = sub.subscriptionId ?? `${sub.sessionId}\0${sub.triggerType}`;
        if (sub.triggerType === "time:timer_fired") return `timer:${baseId}`;
        if (sub.triggerType === "time:at") return `at:${baseId}`;
        return `cron:${baseId}`;
    }

    #applySubscription(sub: TriggerSubscriptionEntry, action: "subscribe" | "update" | "unsubscribe"): void {
        const { sessionId, triggerType, params } = sub;
        const subscriptionId = sub.subscriptionId ?? `${sessionId}\0${triggerType}`;
        if (triggerType === "time:timer_fired") {
            this.#handleTimerSubscription(subscriptionId, sessionId, params, action);
        } else if (triggerType === "time:at") {
            this.#handleAtSubscription(subscriptionId, sessionId, params, action);
        } else if (triggerType === "time:cron") {
            this.#handleCronSubscription(subscriptionId, sessionId, params, action);
        }
    }

    #handleTimerSubscription(subscriptionId: string, sessionId: string, params: any, action: string): void {
        const key = `timer:${subscriptionId}`;

        // Clean up any existing timer for this session
        const existing = this.#timers.get(key);
        if (existing) {
            clearTimeout(existing.handle);
            this.#timers.delete(key);
        }

        if (action === "unsubscribe") {
            this.#dropTimerState(subscriptionId);
            return;
        }

        const durationStr = typeof params?.duration === "string" ? params.duration : null;
        if (!durationStr) {
            logWarn(`[time] timer subscription from ${sessionId} missing duration param`);
            return;
        }

        const durationMs = parseDuration(durationStr);
        if (durationMs === null) {
            logWarn(`[time] invalid duration "${durationStr}" from session ${sessionId}`);
            return;
        }

        const label = typeof params?.label === "string" ? params.label : undefined;
        const message = typeof params?.message === "string" ? params.message : undefined;
        const cwd = cwdFromParams(params);
        const resumePath = resumePathFromParams(params);
        // Reuse the persisted absolute deadline (daemon restarts must not
        // rebuild the timer as now+duration — the deadline would drift forever).
        // A changed duration param invalidates the persisted entry.
        const persistedFireAt = this.#persistedTimerFireAt(subscriptionId, durationStr);
        const fireAt = persistedFireAt ?? Date.now() + durationMs;
        if (persistedFireAt === null) this.#persistTimer(subscriptionId, fireAt, durationStr);

        logInfo(`[time] starting timer for session ${sessionId}: ${durationStr} (${formatDuration(durationMs)})${label ? ` [${label}]` : ""}`);

        const summary = message ?? (label ? `Timer "${label}" fired after ${formatDuration(durationMs)}` : `Timer fired after ${formatDuration(durationMs)}`);
        const buildPayload = () => ({ duration: durationStr, durationMs, firedAt: new Date().toISOString(), label, message });
        const replacementPrompt = buildReplacementPrompt(`timer "${durationStr}"`, label, message);
        const fire = () => {
            this.#timers.delete(key);
            this.#dropTimerState(subscriptionId);
            this.#fireOneShotWithRetry(key, sessionId, subscriptionId, "time:timer_fired", buildPayload, summary, label, 0, replacementPrompt, cwd, resumePath);
        };

        const handle = this.#setTimeoutUntil(key, fireAt, fire);

        this.#timers.set(key, {
            subscriptionId,
            handle,
            fireAt,
            sessionId,
            triggerType: "time:timer_fired",
            label,
        });
    }

    /**
     * setTimeout against an absolute deadline. Delays beyond 2^31-1 ms overflow
     * setTimeout and fire immediately, so longer waits are chained in max-size
     * hops; each hop refreshes the handle stored in #timers under `key` so
     * clearTimeout on unsubscribe still cancels the live hop.
     */
    #setTimeoutUntil(key: string, fireAt: number, cb: () => void): ReturnType<typeof setTimeout> {
        const remaining = fireAt - Date.now();
        if (remaining <= MAX_TIMEOUT_MS) return setTimeout(cb, Math.max(0, remaining));
        return setTimeout(() => {
            const entry = this.#timers.get(key);
            if (!entry) return; // unsubscribed while waiting
            entry.handle = this.#setTimeoutUntil(key, fireAt, cb);
        }, MAX_TIMEOUT_MS);
    }

    #handleAtSubscription(subscriptionId: string, sessionId: string, params: any, action: string): void {
        const key = `at:${subscriptionId}`;

        const existing = this.#timers.get(key);
        if (existing) {
            clearTimeout(existing.handle);
            this.#timers.delete(key);
        }

        if (action === "unsubscribe") return;

        const atStr = typeof params?.at === "string" ? params.at : null;
        if (!atStr) {
            logWarn(`[time] at subscription from ${sessionId} missing 'at' param`);
            return;
        }

        const targetMs = parseTimeString(atStr);
        if (targetMs === null) {
            logWarn(`[time] invalid time "${atStr}" from session ${sessionId}`);
            return;
        }

        const label = typeof params?.label === "string" ? params.label : undefined;
        const message = typeof params?.message === "string" ? params.message : undefined;
        const cwd = cwdFromParams(params);
        const resumePath = resumePathFromParams(params);

        const summary = message ?? (label ? `Scheduled "${label}" fired` : `Scheduled trigger fired (target: ${atStr})`);
        const buildPayload = () => ({ at: new Date(targetMs).toISOString(), firedAt: new Date().toISOString(), label, message });
        const replacementPrompt = buildReplacementPrompt(`scheduled time ${atStr}`, label, message);
        const fire = () => {
            this.#timers.delete(key);
            this.#fireOneShotWithRetry(key, sessionId, subscriptionId, "time:at", buildPayload, summary, label, 0, replacementPrompt, cwd, resumePath);
        };

        const delayMs = targetMs - Date.now();
        if (delayMs <= 0) {
            // Already past — fire immediately
            logInfo(`[time] at target "${atStr}" already passed, firing immediately for session ${sessionId}`);
            fire();
            return;
        }

        logInfo(`[time] scheduling at-timer for session ${sessionId}: ${atStr} (in ${formatDuration(delayMs)})${label ? ` [${label}]` : ""}`);

        const handle = this.#setTimeoutUntil(key, targetMs, fire);

        this.#timers.set(key, {
            subscriptionId,
            handle,
            fireAt: targetMs,
            sessionId,
            triggerType: "time:at",
            label,
        });
    }

    #handleCronSubscription(subscriptionId: string, sessionId: string, params: any, action: string): void {
        const key = `cron:${subscriptionId}`;

        const existing = this.#crons.get(key);
        if (existing) {
            clearInterval(existing.handle);
            this.#crons.delete(key);
        }
        this.#cronIterations.delete(key);

        if (action === "unsubscribe") {
            this.#dropCronState(subscriptionId);
            return;
        }

        const cronStr = typeof params?.cron === "string" ? params.cron : null;
        if (!cronStr) {
            logWarn(`[time] cron subscription from ${sessionId} missing 'cron' param`);
            return;
        }

        const cron = parseCron(cronStr);
        if (!cron) {
            logWarn(`[time] invalid cron "${cronStr}" from session ${sessionId}`);
            return;
        }

        const label = typeof params?.label === "string" ? params.label : undefined;
        const message = typeof params?.message === "string" ? params.message : undefined;
        const cwd = cwdFromParams(params);
        const resumePath = resumePathFromParams(params);

        // Restore durable next-fire/iteration so a restart neither re-fires a
        // cron that already ran this period nor resets its iteration count. A
        // persisted nextFireAt in the past (missed while the runner was down)
        // fires once on the next tick — catch-up, not a replay of every miss.
        const persisted = this.#getCronState()[subscriptionId];
        const nextFire = (persisted && typeof persisted.nextFireAt === "number")
            ? persisted.nextFireAt
            : nextCronTime(cron);
        if (!nextFire) {
            logWarn(`[time] cron "${cronStr}" has no next fire time`);
            return;
        }
        const iteration = (persisted && typeof persisted.iteration === "number") ? persisted.iteration : 0;

        logInfo(`[time] starting cron for session ${sessionId}: "${cronStr}" (next: ${new Date(nextFire).toISOString()})${label ? ` [${label}]` : ""}`);
        this.#cronIterations.set(key, iteration);

        const entry: CronEntry = {
            subscriptionId,
            handle: null as unknown as ReturnType<typeof setInterval>,
            cron,
            sessionId,
            label,
            nextFireAt: nextFire,
            delivering: false,
            retryCount: 0,
        };

        // Check every 30 seconds for cron matches. A failed delivery holds
        // nextFireAt (retried with backoff) instead of silently skipping the
        // iteration.
        const deliver = (): void => {
            const current = this.#crons.get(key);
            if (!current || current.delivering) return;
            const now = Date.now();
            if (now < current.nextFireAt) return;

            current.delivering = true;
            const nextIteration = (this.#cronIterations.get(key) ?? 0) + 1;
            void this.#deliverToSession(sessionId, "time:cron", {
                cron: cronStr,
                firedAt: new Date().toISOString(),
                label,
                message,
                iteration: nextIteration,
            }, message ?? (label ? `Cron "${label}" fired (#${nextIteration})` : `Cron "${cronStr}" fired (#${nextIteration})`)).then(async (result) => {
                const cur = this.#crons.get(key);
                if (!cur) return; // unsubscribed while delivering

                if (result === "delivered") {
                    cur.delivering = false;
                    this.#cronIterations.set(key, nextIteration);
                    cur.retryCount = 0;
                    const nextTime = nextCronTime(cron, now);
                    if (nextTime) {
                        cur.nextFireAt = nextTime;
                        this.#persistCron(subscriptionId, nextTime, nextIteration);
                    } else {
                        // No more fire times — clean up
                        clearInterval(cur.handle);
                        this.#crons.delete(key);
                        this.#cronIterations.delete(key);
                        this.#dropCronState(subscriptionId);
                    }
                } else if (result === "gone" && sessionId.startsWith("runner-listener:")) {
                    // The listener row was deleted server-side — the schedule is
                    // gone; drop the cron instead of migrating it to a session.
                    logWarn(`[time] cron "${cronStr}" listener ${sessionId} no longer exists — dropping schedule`);
                    clearInterval(cur.handle);
                    this.#crons.delete(key);
                    this.#cronIterations.delete(key);
                    this.#dropCronState(subscriptionId);
                } else if (result === "gone") {
                    // The owning session no longer exists — the recurring schedule
                    // must survive: start a new session for this fire and re-own
                    // the cron under it so future fires deliver there. Keep
                    // `delivering` held while migrating so the interval cannot
                    // start a second migration.
                    const spawn = await this.#spawnReplacementSession(
                        buildReplacementPrompt(`cron "${cronStr}"`, label, message, true),
                        cwd,
                        resumePath,
                    );
                    const afterSpawn = this.#crons.get(key);
                    if (!afterSpawn) return; // unsubscribed while migrating
                    // NOTE: `delivering` stays held across the handover below.
                    // Releasing it here lets the next interval tick see the old
                    // (past) nextFireAt and start a SECOND migration while this
                    // one is still awaiting — spawning a duplicate session.
                    if ("sessionId" in spawn) {
                        const migrated = await this.#resubscribeCron(spawn.sessionId, {
                            cron: cronStr,
                            ...(message ? { message } : {}),
                            ...(label ? { label } : {}),
                            ...(cwd ? { _cwd: cwd } : {}),
                            ...(resumePath ? { _resumePath: resumePath } : {}),
                        });
                        const stillMounted = this.#crons.get(key);
                        if (!stillMounted) return;
                        stillMounted.delivering = false;
                        if (migrated) {
                            // Retire the old subscription. It is durable, so leaving
                            // it would restore it on the next reconnect snapshot,
                            // re-arm this cron against a dead session, and migrate
                            // AGAIN — one extra subscription and session per restart.
                            await this.#removeSubscription(sessionId, "time:cron", subscriptionId);
                            logInfo(`[time] cron "${cronStr}" owner ${sessionId} is gone — re-owned by new session ${spawn.sessionId}`);
                            clearInterval(stillMounted.handle);
                            this.#crons.delete(key);
                            this.#cronIterations.delete(key);
                            this.#dropCronState(subscriptionId);
                        } else {
                            // The fire ran (a session is doing the work) but the
                            // recurrence could not be handed over. Keep THIS cron
                            // armed at its next natural time so the schedule is not
                            // downgraded to a one-off, and try the handover again.
                            const nextTime = nextCronTime(cron, Date.now());
                            if (nextTime) {
                                stillMounted.nextFireAt = nextTime;
                                stillMounted.retryCount = 0;
                                this.#persistCron(subscriptionId, nextTime, nextIteration);
                                this.#cronIterations.set(key, nextIteration);
                                logWarn(`[time] cron "${cronStr}" ran as ${spawn.sessionId} but could not be re-owned; keeping the old schedule armed for ${new Date(nextTime).toISOString()}`);
                            }
                        }
                    } else if (spawn.failure === "permanent") {
                        afterSpawn.delivering = false;
                        // The spawn cannot succeed as configured (e.g. its cwd is
                        // gone). Do not hammer every 30 minutes forever — wait for
                        // the next natural fire, which also lets it self-heal if
                        // the workspace comes back.
                        const nextTime = nextCronTime(cron, Date.now());
                        if (nextTime) {
                            afterSpawn.nextFireAt = nextTime;
                            afterSpawn.retryCount = 0;
                            this.#persistCron(subscriptionId, nextTime, this.#cronIterations.get(key) ?? 0);
                            logError(`[time] cron "${cronStr}" cannot start a replacement session (permanent failure); skipping to ${new Date(nextTime).toISOString()}`);
                        } else {
                            clearInterval(afterSpawn.handle);
                            this.#crons.delete(key);
                            this.#cronIterations.delete(key);
                            this.#dropCronState(subscriptionId);
                        }
                    } else {
                        // Transient — hold the fire and retry with backoff.
                        afterSpawn.delivering = false;
                        afterSpawn.retryCount++;
                        afterSpawn.nextFireAt = Date.now() + this.#backoffDelay(afterSpawn.retryCount - 1);
                        logWarn(`[time] cron "${cronStr}" owner ${sessionId} is gone and replacement spawn failed; retrying in ${formatDuration(afterSpawn.nextFireAt - Date.now())}`);
                    }
                } else {
                    // Transient — retry the same fire with backoff.
                    cur.delivering = false;
                    cur.retryCount++;
                    cur.nextFireAt = now + this.#backoffDelay(cur.retryCount - 1);
                    logWarn(`[time] cron "${cronStr}" delivery to ${sessionId} failed; retrying in ${formatDuration(cur.nextFireAt - now)}`);
                }
            });
        };

        const handle = setInterval(deliver, this.cronCheckIntervalMs);
        entry.handle = handle;
        this.#crons.set(key, entry);

        this.#persistCron(subscriptionId, nextFire, iteration);
    }

    // ── Trigger delivery ─────────────────────────────────────────────

    /**
     * Fire a one-shot follow-up: deliver to the owning session, then remove
     * the subscription so it doesn't re-arm and re-fire on runner restart.
     */
    async #fireOneShot(
        sessionId: string,
        subscriptionId: string,
        type: string,
        payload: Record<string, unknown>,
        summary?: string,
    ): Promise<DeliveryResult> {
        const result = await this.#deliverToSession(sessionId, type, payload, summary);
        if (result === "delivered") {
            await this.#removeSubscription(sessionId, type, subscriptionId);
        }
        return result;
    }

    /**
     * Fire a one-shot with full schedule-durability semantics:
     *   - delivered → done (subscription removed);
     *   - transient failure (offline session is being woken server-side via
     *     wakeSession) → re-arm with backoff and retry;
     *   - session gone → the schedule must still run: start a NEW session with
     *     the schedule's instruction as its prompt. Spawn failure retries.
     */
    #fireOneShotWithRetry(
        key: string,
        sessionId: string,
        subscriptionId: string,
        triggerType: "time:timer_fired" | "time:at",
        buildPayload: () => Record<string, unknown>,
        summary: string,
        label: string | undefined,
        retryCount: number,
        replacementPrompt: string,
        cwd: string | undefined,
        resumePath: string | undefined,
    ): void {
        void this.#fireOneShot(sessionId, subscriptionId, triggerType, buildPayload(), summary).then(async (result) => {
            if (this.#disposed) return;
            if (result === "delivered") return;
            if (result === "gone") {
                if (sessionId.startsWith("runner-listener:")) {
                    // A runner-listener pseudo-session fires by spawning its own
                    // session server-side; "gone" means the listener row was
                    // deleted — the schedule no longer exists, don't resurrect it.
                    logWarn(`[time] ${triggerType} listener ${sessionId} no longer exists — dropping`);
                    return;
                }
                const spawn = await this.#spawnReplacementSession(replacementPrompt, cwd, resumePath);
                if ("sessionId" in spawn) {
                    // The one-shot has been handed to a live session; retire the
                    // subscription so it cannot re-arm on the next restart.
                    await this.#removeSubscription(sessionId, triggerType, subscriptionId);
                    logInfo(`[time] ${triggerType} owner ${sessionId} is gone — handled by new session ${spawn.sessionId}`);
                    return;
                }
                if (spawn.failure === "permanent") {
                    // Undeliverable as configured. Stop the retry loop rather than
                    // waking every 30 minutes forever; the subscription is left in
                    // place so it stays visible and cancellable in the UI.
                    logError(`[time] ${triggerType} for gone session ${sessionId} cannot start a replacement session (permanent failure) — giving up on this fire`);
                    return;
                }
                logWarn(`[time] ${triggerType} owner ${sessionId} is gone and replacement spawn failed; retrying`);
            }
            const delay = this.#backoffDelay(retryCount);
            const fireAt = Date.now() + delay;
            logWarn(`[time] ${triggerType} delivery to ${sessionId} failed; retrying in ${formatDuration(delay)}`);
            const handle = this.#setTimeoutUntil(key, fireAt, () => {
                this.#timers.delete(key);
                this.#fireOneShotWithRetry(key, sessionId, subscriptionId, triggerType, buildPayload, summary, label, retryCount + 1, replacementPrompt, cwd, resumePath);
            });
            this.#timers.set(key, { subscriptionId, handle, fireAt, sessionId, triggerType, label });
        });
    }

    /**
     * The owning session no longer exists — start a fresh session on this
     * runner with the schedule's instruction as its initial prompt.
     *
     * A 4xx is permanent for this input (a deleted `_cwd`, a cwd outside the
     * runner's roots, a forbidden model): retrying it on a timer just hammers
     * the relay forever. Those retry ONCE without the cwd — the workspace may
     * be gone while the schedule is still worth running — and then report
     * "permanent" so the caller stops instead of looping.
     */
    async #spawnReplacementSession(
        prompt: string,
        cwd: string | undefined,
        resumePath?: string,
    ): Promise<{ sessionId: string } | { failure: "transient" | "permanent" }> {
        const apiKey = getApiKey();
        const runnerId = getOwnRunnerId();
        if (!apiKey || !runnerId) {
            logWarn(`[time] cannot spawn replacement session — missing ${apiKey ? "runnerId" : "apiKey"}`);
            return { failure: "transient" };
        }

        const attempt = async (withCwd: string | undefined): Promise<{ sessionId: string } | { failure: "transient" | "permanent" }> => {
            try {
                const res = await fetch(`${resolveRelayUrl()}/api/runners/spawn`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
                    signal: AbortSignal.timeout(this.deliveryTimeoutMs),
                    body: JSON.stringify({
                        runnerId,
                        prompt,
                        ...(withCwd ? { cwd: withCwd } : {}),
                        // ponytail: a stale/deleted transcript just logs a warn
                        // worker-side and the session starts fresh — no need to
                        // stat it here from the daemon.
                        ...(resumePath ? { resumePath } : {}),
                    }),
                });
                if (res.ok) {
                    const data = await res.json().catch(() => null) as { sessionId?: string } | null;
                    if (typeof data?.sessionId === "string" && data.sessionId) return { sessionId: data.sessionId };
                    logWarn("[time] replacement session spawn returned no sessionId");
                    return { failure: "transient" };
                }
                const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
                logWarn(`[time] replacement session spawn failed: ${res.status} ${res.statusText}${permanent ? " (permanent)" : ""}`);
                return { failure: permanent ? "permanent" : "transient" };
            } catch (err) {
                logError(`[time] replacement session spawn error: ${err}`);
                return { failure: "transient" };
            }
        };

        const first = await attempt(cwd);
        if ("sessionId" in first) return first;
        if (first.failure === "permanent" && cwd) {
            logWarn(`[time] retrying replacement spawn without cwd "${cwd}" — the workspace may be gone`);
            return await attempt(undefined);
        }
        return first;
    }

    /**
     * Re-own a recurring schedule: subscribe the replacement session to the
     * same cron so future fires deliver there (and survive restarts under the
     * new owner). Best-effort — a failure loses the recurrence but not this
     * fire, and is logged loudly.
     */
    async #resubscribeCron(newSessionId: string, params: Record<string, unknown>): Promise<boolean> {
        const apiKey = getApiKey();
        if (!apiKey) return false;
        // Retried: this single call is what carries the recurrence to its new
        // owner, so dropping it on one blip silently downgrades a standing
        // schedule to a one-off.
        for (let attempt = 0; attempt < RESUBSCRIBE_ATTEMPTS; attempt++) {
            if (this.#disposed) return false;
            try {
                const res = await fetch(`${resolveRelayUrl()}/api/sessions/${encodeURIComponent(newSessionId)}/trigger-subscriptions`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
                    signal: AbortSignal.timeout(this.deliveryTimeoutMs),
                    body: JSON.stringify({ triggerType: "time:cron", params }),
                });
                if (res.ok) return true;
                // A 4xx fails identically next time — don't spend the retries.
                if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                    logError(`[time] failed to re-own cron under session ${newSessionId}: ${res.status} ${res.statusText} — not retryable`);
                    return false;
                }
                logWarn(`[time] re-owning cron under ${newSessionId} failed (${res.status}), attempt ${attempt + 1}/${RESUBSCRIBE_ATTEMPTS}`);
            } catch (err) {
                logWarn(`[time] re-owning cron under ${newSessionId} errored, attempt ${attempt + 1}/${RESUBSCRIBE_ATTEMPTS}: ${err}`);
            }
            if (attempt < RESUBSCRIBE_ATTEMPTS - 1) {
                await new Promise((resolve) => setTimeout(resolve, this.#backoffDelay(attempt)));
            }
        }
        logError(`[time] failed to re-own cron under session ${newSessionId} after ${RESUBSCRIBE_ATTEMPTS} attempts`);
        return false;
    }

    /** Deliver a trigger to the session that owns the subscription (not a broadcast). */
    async #deliverToSession(
        sessionId: string,
        type: string,
        payload: Record<string, unknown>,
        summary?: string,
    ): Promise<DeliveryResult> {
        const apiKey = getApiKey();
        if (!apiKey) {
            logWarn(`[time] cannot deliver trigger — missing apiKey`);
            return "retry";
        }

        try {
            const res = await fetch(`${resolveRelayUrl()}/api/sessions/${encodeURIComponent(sessionId)}/trigger`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-api-key": apiKey },
                // A hung delivery must not wedge the cron's `delivering` flag
                // (or drop a one-shot) — bound it and treat a timeout as retry.
                signal: AbortSignal.timeout(this.deliveryTimeoutMs),
                body: JSON.stringify({
                    type,
                    payload,
                    source: "time",
                    deliverAs: "followUp",
                    summary,
                    // A schedule firing must reach the session that created it even
                    // if its worker has exited — the relay wakes it (resume) and
                    // the retry loop delivers into the awakened session.
                    wakeSession: true,
                }),
            });

            if (res.ok) {
                logInfo(`[time] delivered ${type} to ${sessionId}: ${summary ?? "(no summary)"}`);
                return "delivered";
            }
            // 404 = session gone (permanent); 503 = offline (transient).
            if (res.status === 404) {
                logWarn(`[time] trigger delivery to ${sessionId} failed: session not found`);
                return "gone";
            }
            logWarn(`[time] trigger delivery to ${sessionId} failed: ${res.status} ${res.statusText}`);
            return "retry";
        } catch (err) {
            logError(`[time] trigger delivery error: ${err}`);
            return "retry";
        }
    }

    /** Remove a fired one-shot subscription server-side. */
    async #removeSubscription(sessionId: string, triggerType: string, subscriptionId: string): Promise<void> {
        // Legacy entries without a real subscriptionId use a fabricated
        // "<sessionId>\0<triggerType>" key — skip targeted deletion for those.
        if (subscriptionId.includes("\0")) return;

        const apiKey = getApiKey();
        if (!apiKey) return;

        try {
            const res = await fetch(
                `${resolveRelayUrl()}/api/sessions/${encodeURIComponent(sessionId)}/trigger-subscriptions/${encodeURIComponent(triggerType)}?subscriptionId=${encodeURIComponent(subscriptionId)}`,
                { method: "DELETE", headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(this.deliveryTimeoutMs) },
            );
            if (!res.ok) {
                logWarn(`[time] failed to remove fired subscription ${subscriptionId}: ${res.status} ${res.statusText}`);
            }
        } catch (err) {
            logWarn(`[time] error removing fired subscription ${subscriptionId}: ${err}`);
        }
    }
}
