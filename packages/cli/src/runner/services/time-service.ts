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
import { existsSync, readFileSync } from "node:fs";
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
    return process.env.PIZZAPI_RUNNER_API_KEY ?? process.env.PIZZAPI_API_KEY ?? null;
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
        description: "Recurring follow-up on a cron schedule. Standard 5-field format: minute hour day-of-month month day-of-week. Delivered only to your session; unsubscribe when you no longer need it.",
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
                description: "Standard 5-field cron (e.g. \"*/30 * * * *\" for every 30 minutes)",
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
                    logInfo(`[time] reconcile: removed stale timer ${key}`);
                }
            }
            for (const [key, cron] of this.#crons) {
                if (!snapshotKeys.has(key)) {
                    clearInterval(cron.handle);
                    this.#crons.delete(key);
                    this.#cronIterations.delete(key);
                    logInfo(`[time] reconcile: removed stale cron ${key}`);
                }
            }
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

        if (action === "unsubscribe") return;

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
        const fireAt = Date.now() + durationMs;

        logInfo(`[time] starting timer for session ${sessionId}: ${durationStr} (${formatDuration(durationMs)})${label ? ` [${label}]` : ""}`);

        const handle = this.#setTimeoutUntil(key, fireAt, () => {
            this.#timers.delete(key);
            void this.#fireOneShot(sessionId, subscriptionId, "time:timer_fired", {
                duration: durationStr,
                durationMs,
                firedAt: new Date().toISOString(),
                label,
                message,
            }, message ?? (label ? `Timer "${label}" fired after ${formatDuration(durationMs)}` : `Timer fired after ${formatDuration(durationMs)}`));
        });

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

        const delayMs = targetMs - Date.now();
        if (delayMs <= 0) {
            // Already past — fire immediately
            logInfo(`[time] at target "${atStr}" already passed, firing immediately for session ${sessionId}`);
            void this.#fireOneShot(sessionId, subscriptionId, "time:at", {
                at: new Date(targetMs).toISOString(),
                firedAt: new Date().toISOString(),
                label,
                message,
            }, message ?? `Scheduled trigger fired (target: ${atStr})`);
            return;
        }

        logInfo(`[time] scheduling at-timer for session ${sessionId}: ${atStr} (in ${formatDuration(delayMs)})${label ? ` [${label}]` : ""}`);

        const handle = this.#setTimeoutUntil(key, targetMs, () => {
            this.#timers.delete(key);
            void this.#fireOneShot(sessionId, subscriptionId, "time:at", {
                at: new Date(targetMs).toISOString(),
                firedAt: new Date().toISOString(),
                label,
                message,
            }, message ?? (label ? `Scheduled "${label}" fired` : `Scheduled trigger fired (target: ${atStr})`));
        });

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

        if (action === "unsubscribe") return;

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
        const nextFire = nextCronTime(cron);
        if (!nextFire) {
            logWarn(`[time] cron "${cronStr}" has no next fire time`);
            return;
        }

        logInfo(`[time] starting cron for session ${sessionId}: "${cronStr}" (next: ${new Date(nextFire).toISOString()})${label ? ` [${label}]` : ""}`);
        this.#cronIterations.set(key, 0);

        // Check every 30 seconds for cron matches
        const handle = setInterval(() => {
            const now = Date.now();
            const entry = this.#crons.get(key);
            if (!entry) return;

            // Check if we've passed the next fire time
            if (now >= entry.nextFireAt) {
                const iteration = (this.#cronIterations.get(key) ?? 0) + 1;
                this.#cronIterations.set(key, iteration);

                void this.#deliverToSession(sessionId, "time:cron", {
                    cron: cronStr,
                    firedAt: new Date().toISOString(),
                    label,
                    message,
                    iteration,
                }, message ?? (label ? `Cron "${label}" fired (#${iteration})` : `Cron "${cronStr}" fired (#${iteration})`));

                // Schedule next
                const nextTime = nextCronTime(cron, now);
                if (nextTime) {
                    entry.nextFireAt = nextTime;
                } else {
                    // No more fire times — clean up
                    clearInterval(handle);
                    this.#crons.delete(key);
                    this.#cronIterations.delete(key);
                }
            }
        }, 30_000);

        this.#crons.set(key, {
            subscriptionId,
            handle,
            cron,
            sessionId,
            label,
            nextFireAt: nextFire,
        });
    }

    // ── Trigger delivery ─────────────────────────────────────────────

    /**
     * Fire a one-shot follow-up: deliver to the owning session, then remove
     * the subscription so it doesn't re-arm and re-fire on runner restart.
     * If delivery fails (e.g. session offline), the subscription is kept so
     * the next reconcile retries it.
     */
    async #fireOneShot(
        sessionId: string,
        subscriptionId: string,
        type: string,
        payload: Record<string, unknown>,
        summary?: string,
    ): Promise<void> {
        const delivered = await this.#deliverToSession(sessionId, type, payload, summary);
        if (delivered) {
            await this.#removeSubscription(sessionId, type, subscriptionId);
        }
    }

    /** Deliver a trigger to the session that owns the subscription (not a broadcast). */
    async #deliverToSession(
        sessionId: string,
        type: string,
        payload: Record<string, unknown>,
        summary?: string,
    ): Promise<boolean> {
        const apiKey = getApiKey();
        if (!apiKey) {
            logWarn(`[time] cannot deliver trigger — missing apiKey`);
            return false;
        }

        try {
            const res = await fetch(`${resolveRelayUrl()}/api/sessions/${encodeURIComponent(sessionId)}/trigger`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-api-key": apiKey },
                body: JSON.stringify({
                    type,
                    payload,
                    source: "time",
                    deliverAs: "followUp",
                    summary,
                }),
            });

            if (!res.ok) {
                logWarn(`[time] trigger delivery to ${sessionId} failed: ${res.status} ${res.statusText}`);
                return false;
            }
            logInfo(`[time] delivered ${type} to ${sessionId}: ${summary ?? "(no summary)"}`);
            return true;
        } catch (err) {
            logError(`[time] trigger delivery error: ${err}`);
            return false;
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
                { method: "DELETE", headers: { "x-api-key": apiKey } },
            );
            if (!res.ok) {
                logWarn(`[time] failed to remove fired subscription ${subscriptionId}: ${res.status} ${res.statusText}`);
            }
        } catch (err) {
            logWarn(`[time] error removing fired subscription ${subscriptionId}: ${err}`);
        }
    }
}
