/**
 * Built-in Time service — timer triggers and adaptive time sigils.
 *
 * Triggers:
 *   time:timer_fired  — one-shot delay timer
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
import type { ServiceHandler, ServiceInitOptions } from "../service-handler.js";
import type { ServiceTriggerDef, ServiceSigilDef } from "@pizzapi/protocol";
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

// ── Relay helpers ────────────────────────────────────────────────────────────

function readRunnerId(): string | null {
    try {
        const home = process.env.HOME || homedir();
        const raw = JSON.parse(readFileSync(join(home, ".pizzapi", "runner.json"), "utf-8"));
        return typeof raw?.runnerId === "string" ? raw.runnerId : null;
    } catch { return null; }
}

function resolveRelayUrl(): string {
    const home = process.env.HOME || homedir();
    let raw = process.env.PIZZAPI_RELAY_URL?.trim();
    if (!raw) {
        try {
            const cfg = JSON.parse(readFileSync(join(home, ".pizzapi", "config.json"), "utf-8"));
            if (typeof cfg?.relayUrl === "string" && cfg.relayUrl !== "off") raw = cfg.relayUrl.trim();
        } catch { /* ignore */ }
    }
    raw = raw || "http://localhost:7492";
    if (raw.startsWith("ws://")) return raw.replace(/^ws:/, "http:").replace(/\/$/, "");
    if (raw.startsWith("wss://")) return raw.replace(/^wss:/, "https:").replace(/\/$/, "");
    return raw.replace(/\/$/, "");
}

function getApiKey(): string | null {
    return process.env.PIZZAPI_RUNNER_API_KEY ?? process.env.PIZZAPI_API_KEY ?? null;
}

// ── Timer state ──────────────────────────────────────────────────────────────

interface TimerEntry {
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
        label: "Timer Fired",
        description: "One-shot delay timer. Subscribe with a duration (e.g. \"10m\", \"1h30m\", \"30s\") and receive a trigger when it elapses.",
        schema: {
            type: "object",
            properties: {
                duration: { type: "string", description: "The original duration string" },
                durationMs: { type: "number", description: "Duration in milliseconds" },
                firedAt: { type: "string", description: "ISO timestamp when the timer fired" },
                label: { type: "string", description: "Optional label" },
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
        label: "Fire At Time",
        description: "Fire a trigger at a specific absolute time. Supports ISO 8601 (\"2026-03-30T08:00:00Z\") and HH:MMUTC (\"14:30UTC\").",
        schema: {
            type: "object",
            properties: {
                at: { type: "string", description: "The target time (ISO 8601)" },
                firedAt: { type: "string", description: "ISO timestamp when the trigger fired" },
                label: { type: "string", description: "Optional label" },
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
        description: "Periodic trigger on a cron schedule. Standard 5-field format: minute hour day-of-month month day-of-week.",
        schema: {
            type: "object",
            properties: {
                cron: { type: "string", description: "The cron expression" },
                firedAt: { type: "string", description: "ISO timestamp when the trigger fired" },
                label: { type: "string", description: "Optional label" },
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
    #onSubscriptionChanged: ((data: any) => void) | null = null;

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

        // Listen for subscription changes to start/stop timers
        this.#onSubscriptionChanged = (data: any) => {
            if (!data || typeof data !== "object") return;
            const { sessionId, triggerType, params, action } = data;
            if (typeof triggerType !== "string" || typeof sessionId !== "string") return;

            if (triggerType === "time:timer_fired") {
                this.#handleTimerSubscription(sessionId, params, action);
            } else if (triggerType === "time:at") {
                this.#handleAtSubscription(sessionId, params, action);
            } else if (triggerType === "time:cron") {
                this.#handleCronSubscription(sessionId, params, action);
            }
        };

        (socket as any).on("subscription_params_changed", this.#onSubscriptionChanged);

        logInfo(`[time] service started, resolve server on port ${this.#server.port}`);
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

        // Remove socket listener
        if (this.#socket && this.#onSubscriptionChanged) {
            (this.#socket as any).off("subscription_params_changed", this.#onSubscriptionChanged);
        }
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

    #handleTimerSubscription(sessionId: string, params: any, action: string): void {
        const key = `timer:${sessionId}`;

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
        const fireAt = Date.now() + durationMs;

        logInfo(`[time] starting timer for session ${sessionId}: ${durationStr} (${formatDuration(durationMs)})${label ? ` [${label}]` : ""}`);

        const handle = setTimeout(() => {
            this.#timers.delete(key);
            void this.#broadcastTrigger("time:timer_fired", {
                duration: durationStr,
                durationMs,
                firedAt: new Date().toISOString(),
                label,
            }, label ? `Timer "${label}" fired after ${formatDuration(durationMs)}` : `Timer fired after ${formatDuration(durationMs)}`);
        }, durationMs);

        this.#timers.set(key, {
            handle,
            fireAt,
            sessionId,
            triggerType: "time:timer_fired",
            label,
        });
    }

    #handleAtSubscription(sessionId: string, params: any, action: string): void {
        const key = `at:${sessionId}`;

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

        const delayMs = targetMs - Date.now();
        if (delayMs <= 0) {
            // Already past — fire immediately
            logInfo(`[time] at target "${atStr}" already passed, firing immediately for session ${sessionId}`);
            void this.#broadcastTrigger("time:at", {
                at: new Date(targetMs).toISOString(),
                firedAt: new Date().toISOString(),
                label: typeof params?.label === "string" ? params.label : undefined,
            }, `Scheduled trigger fired (target: ${atStr})`);
            return;
        }

        const label = typeof params?.label === "string" ? params.label : undefined;

        logInfo(`[time] scheduling at-timer for session ${sessionId}: ${atStr} (in ${formatDuration(delayMs)})${label ? ` [${label}]` : ""}`);

        const handle = setTimeout(() => {
            this.#timers.delete(key);
            void this.#broadcastTrigger("time:at", {
                at: new Date(targetMs).toISOString(),
                firedAt: new Date().toISOString(),
                label,
            }, label ? `Scheduled "${label}" fired` : `Scheduled trigger fired (target: ${atStr})`);
        }, delayMs);

        this.#timers.set(key, {
            handle,
            fireAt: targetMs,
            sessionId,
            triggerType: "time:at",
            label,
        });
    }

    #handleCronSubscription(sessionId: string, params: any, action: string): void {
        const key = `cron:${sessionId}`;

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

                void this.#broadcastTrigger("time:cron", {
                    cron: cronStr,
                    firedAt: new Date().toISOString(),
                    label,
                    iteration,
                }, label ? `Cron "${label}" fired (#${iteration})` : `Cron "${cronStr}" fired (#${iteration})`);

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
            handle,
            cron,
            sessionId,
            label,
            nextFireAt: nextFire,
        });
    }

    // ── Trigger broadcasting ─────────────────────────────────────────────

    async #broadcastTrigger(
        type: string,
        payload: Record<string, unknown>,
        summary?: string,
    ): Promise<void> {
        const runnerId = readRunnerId();
        const apiKey = getApiKey();
        if (!runnerId || !apiKey) {
            logWarn(`[time] cannot broadcast trigger — missing runnerId or apiKey`);
            return;
        }

        try {
            const res = await fetch(`${resolveRelayUrl()}/api/runners/${runnerId}/trigger-broadcast`, {
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
                logWarn(`[time] trigger broadcast failed: ${res.status} ${res.statusText}`);
            } else {
                logInfo(`[time] broadcast ${type}: ${summary ?? "(no summary)"}`);
            }
        } catch (err) {
            logError(`[time] trigger broadcast error: ${err}`);
        }
    }
}
