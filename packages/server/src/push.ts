import webpush from "web-push";
import { getKysely } from "./auth.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("push");

// ── VAPID configuration ─────────────────────────────────────────────────────
//
// Provide VAPID keys via env vars. If not set, generate ephemeral ones
// (fine for dev, but push subscriptions won't survive server restarts).

let vapidPublicKey = process.env.VAPID_PUBLIC_KEY ?? "";
let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY ?? "";

/**
 * Validate that VAPID keys are well-formed before passing them to web-push.
 * The private key must decode to exactly 32 bytes (256-bit EC key).
 * The public key must decode to exactly 65 bytes (uncompressed EC point).
 * Returns true if both keys look valid; false otherwise.
 */
function areVapidKeysValid(publicKey: string, privateKey: string): boolean {
    if (!publicKey || !privateKey) return false;
    try {
        // web-push expects URL-safe base64. Decode and check byte lengths.
        const privBytes = Buffer.from(privateKey, "base64url");
        const pubBytes = Buffer.from(publicKey, "base64url");
        // EC P-256: private key = 32 bytes, public key (uncompressed) = 65 bytes
        if (privBytes.length !== 32) return false;
        if (pubBytes.length !== 65) return false;
        return true;
    } catch {
        return false;
    }
}

if (!areVapidKeysValid(vapidPublicKey, vapidPrivateKey)) {
    if (vapidPublicKey || vapidPrivateKey) {
        // Keys were provided but are malformed — warn loudly so the user can fix them.
        log.warn("⚠️  VAPID keys are set but invalid (private key must be 32 bytes, public key 65 bytes when base64url-decoded).");
        log.warn("   Falling back to ephemeral keys.");
    }
    const generated = webpush.generateVAPIDKeys();
    vapidPublicKey = generated.publicKey;
    vapidPrivateKey = generated.privateKey;
    log.warn("⚠️  No valid VAPID keys configured — using ephemeral keys.");
    log.warn("   Push subscriptions will break on every server restart.");
    log.warn("   To fix, add these to your environment:");
    log.warn(`   VAPID_PUBLIC_KEY=${vapidPublicKey}`);
    log.warn(`   VAPID_PRIVATE_KEY=<generated — check server env or regenerate with web-push generate-vapid-keys>`);
    log.warn(`   VAPID_SUBJECT=mailto:your@email.com`);
}

const vapidSubject = process.env.VAPID_SUBJECT ?? "mailto:admin@pizzapi.local";

webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

export function getVapidPublicKey(): string {
    return vapidPublicKey;
}

// ── Push endpoint validation ─────────────────────────────────────────────────

/**
 * Known push service hostnames.
 * This list covers the major browser push services. It is not exhaustive —
 * enterprise / custom push proxies will fail validation and should add their
 * domains here. The primary goal is to block SSRF-style attacks where an
 * attacker registers a subscription pointing to an internal service.
 */
const KNOWN_PUSH_SERVICE_HOSTS = new Set([
    // Google / Chrome
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    // Mozilla / Firefox
    "push.services.mozilla.com",
    "updates.push.services.mozilla.com",
    // Apple / Safari
    "api.push.apple.com",
    "web.push.apple.com",
    // Microsoft Edge
    "wns2.notify.windows.com",
    "wns.notify.windows.com",
    // Samsung Internet
    "fcm.googleapis.com", // Samsung uses FCM
    // Opera (also FCM-based)
    // Brave (Chromium, also FCM-based)
]);

/**
 * RFC1918 / loopback / link-local IPv4 ranges that push endpoints must not target.
 * Checked against the raw hostname to block SSRF attacks.
 */
const PRIVATE_IP_PATTERNS = [
    /^127\./,                    // 127.0.0.0/8 loopback
    /^10\./,                     // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
    /^192\.168\./,               // 192.168.0.0/16
    /^169\.254\./,               // 169.254.0.0/16 link-local
    /^\[::1\]$/,                 // IPv6 loopback — URL API returns "[::1]" with brackets
    /^\[f[cd][0-9a-f]{2}:/i,      // IPv6 ULA fc00::/7 (fc** and fd**) — URL API wraps IPv6 in "[...]"
    /^\[fe[89ab][0-9a-f]:/i,     // IPv6 link-local fe80::/10
    /^0\./,                      // 0.0.0.0/8
    /^\[::\]$/,                  // IPv6 all-interfaces bind address (:: / ::/128)
];

/**
 * Validate that a push subscription endpoint is safe to use.
 *
 * Requirements:
 *   1. Must be a valid URL.
 *   2. Must use the `https:` scheme.
 *   3. Hostname must not be a loopback, link-local, or RFC1918 address.
 *
 * Note: KNOWN_PUSH_SERVICE_HOSTS is retained as documentation of the major
 * browser push services, but is NOT used as a hard allowlist gate. Enforcing
 * an allowlist would break enterprise proxies and custom push providers that
 * use HTTPS on public addresses — those used to work and should continue to
 * work. The primary SSRF defence is the private-IP block above.
 *
 * Returns true if the endpoint is safe; false otherwise.
 */
export function isValidPushEndpoint(endpoint: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(endpoint);
    } catch {
        return false;
    }

    // Must be HTTPS
    if (parsed.protocol !== "https:") return false;

    const host = parsed.hostname.toLowerCase();

    // Reject localhost / .localhost hostnames (hostname-based loopback).
    // The IP-based patterns below do not catch the plain string "localhost".
    if (host === "localhost" || host.endsWith(".localhost")) return false;

    // Reject IPv4-mapped IPv6 addresses (::ffff:x.x.x.x).
    // Bun's URL API normalizes the dotted-decimal form to hex pairs before we
    // ever see it:  [::ffff:127.0.0.1] → [::ffff:7f00:1]
    // We match the two 16-bit hex groups, convert them back to dotted-decimal
    // IPv4, then check against the same private-range patterns.
    const ipv4MappedMatch = host.match(/^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/);
    if (ipv4MappedMatch) {
        const high = parseInt(ipv4MappedMatch[1], 16);
        const low = parseInt(ipv4MappedMatch[2], 16);
        const innerIpv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
        for (const pattern of PRIVATE_IP_PATTERNS) {
            if (pattern.test(innerIpv4)) return false;
        }
        // Inner IPv4 is public — fall through to the normal allow path.
    }

    // Reject private/loopback addresses (SSRF protection).
    for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(host)) return false;
    }

    // Any HTTPS endpoint on a non-private host is accepted.
    return true;
}

// ── DB table ─────────────────────────────────────────────────────────────────

export interface PushSubscriptionTable {
    id: string;
    userId: string;
    endpoint: string;
    /** JSON-stringified PushSubscription.keys */
    keys: string;
    createdAt: string;
    /** Comma-separated list of enabled event types, or "*" for all */
    enabledEvents: string;
    /** Whether to suppress notifications from linked child sessions (0 = no, 1 = yes) */
    suppressChildNotifications: number;
}

export async function ensurePushSubscriptionTable(): Promise<void> {
    await getKysely().schema
        .createTable("push_subscription")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("endpoint", "text", (col) => col.notNull())
        .addColumn("keys", "text", (col) => col.notNull())
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("enabledEvents", "text", (col) => col.notNull().defaultTo("*"))
        .execute();

    // Migration: add suppressChildNotifications column if it doesn't exist yet.
    // SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we attempt the ALTER
    // and ignore only the "duplicate column" error. Any other failure (lock,
    // I/O, malformed schema) is rethrown so startup fails loudly rather than
    // booting with a partially-migrated schema.
    try {
        await getKysely().schema
            .alterTable("push_subscription")
            .addColumn("suppressChildNotifications", "integer", (col) => col.notNull().defaultTo(0))
            .execute();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column name")) {
            throw err;
        }
        // Column already exists — safe to continue.
    }

    await getKysely().schema
        .createIndex("push_subscription_user_idx")
        .ifNotExists()
        .on("push_subscription")
        .column("userId")
        .execute();

    await getKysely().schema
        .createIndex("push_subscription_endpoint_idx")
        .ifNotExists()
        .on("push_subscription")
        .column("endpoint")
        .execute();
}

// ── Subscribe / Unsubscribe ─────────────────────────────────────────────────

export interface PushSubscribeInput {
    userId: string;
    endpoint: string;
    keys: { p256dh: string; auth: string };
    enabledEvents?: string;
    suppressChildNotifications?: boolean;
}

// ── Native push (ntfy) configuration ─────────────────────────────────────────
//
// Self-hosted ntfy delivers Android background push without Google/FCM. The
// device holds a persistent subscribe stream to a per-device topic; the server
// publishes to that topic via one HTTP POST. All three env vars are optional —
// if `PIZZAPI_NTFY_URL` is unset the ntfy branch is a silent no-op and only the
// existing Web Push path runs.
//
// Read lazily from `process.env` at call time (not module load) so runtime
// changes and tests take effect without a restart.

function ntfyConfig() {
    return {
        url: process.env.PIZZAPI_NTFY_URL ?? "",
        publicUrl: process.env.PIZZAPI_NTFY_PUBLIC_URL ?? "",
        publishToken: process.env.PIZZAPI_NTFY_PUBLISH_TOKEN ?? "",
    };
}

/** True when the server is configured to publish via ntfy. */
export function isNtfyConfigured(): boolean {
    return ntfyConfig().url.length > 0;
}

/** Public ntfy base URL to hand to devices (for their subscribe stream). */
export function getNtfyPublicUrl(): string {
    return ntfyConfig().publicUrl;
}

/**
 * Generate an unguessable per-device ntfy topic. 24 random bytes → 48 hex chars.
 * Topic unguessability is the Phase-1 security boundary (alongside the
 * operator's `auth-default-access: deny-all` and the server publish token).
 */
function generateNtfyTopic(): string {
    return `pizzapi-${crypto.getRandomValues(new Uint8Array(24)).reduce(
        (s, b) => s + b.toString(16).padStart(2, "0"),
        "",
    )}`;
}

export interface NativePushRegistrationTable {
    id: string;
    userId: string;
    platform: string;
    topic: string;
    ntfyUser: string | null;
    ntfyPass: string | null;
    createdAt: string;
}

export async function ensureNativePushRegistrationTable(): Promise<void> {
    await getKysely().schema
        .createTable("native_push_registration")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("platform", "text", (col) => col.notNull())
        .addColumn("topic", "text", (col) => col.notNull())
        .addColumn("ntfyUser", "text")
        .addColumn("ntfyPass", "text")
        .addColumn("createdAt", "text", (col) => col.notNull())
        .execute();

    await getKysely().schema
        .createIndex("native_push_registration_user_idx")
        .ifNotExists()
        .on("native_push_registration")
        .column("userId")
        .execute();

    await getKysely().schema
        .createIndex("native_push_registration_topic_idx")
        .ifNotExists()
        .on("native_push_registration")
        .column("topic")
        .execute();
}

export interface RegisterNativeInput {
    userId: string;
    platform: string;
}

/**
 * Register (or refresh) a native push registration for a user, returning the
 * unguessable topic the device should subscribe to. Idempotent per user+platform
 * — re-registering reuses the existing topic so the device keeps its topic
 * across reinstalls of the same user.
 */
export async function registerNativePush(input: RegisterNativeInput): Promise<NativePushRegistrationTable> {
    const platform = input.platform === "android" ? "android" : "android"; // only android today
    // Upsert: reuse an existing registration for this user+platform if present.
    const existing = await getKysely()
        .selectFrom("native_push_registration" as any)
        .selectAll()
        .where("userId", "=", input.userId)
        .where("platform", "=", platform)
        .executeTakeFirst();
    if (existing) return existing as unknown as NativePushRegistrationTable;

    const row: NativePushRegistrationTable = {
        id: crypto.randomUUID(),
        userId: input.userId,
        platform,
        topic: generateNtfyTopic(),
        ntfyUser: null,
        ntfyPass: null,
        createdAt: new Date().toISOString(),
    };
    await getKysely()
        .insertInto("native_push_registration" as any)
        .values(row as any)
        .execute();
    return row;
}

export async function unregisterNativePush(userId: string, platform: string): Promise<boolean> {
    const result = await getKysely()
        .deleteFrom("native_push_registration" as any)
        .where("userId", "=", userId)
        .where("platform", "=", platform)
        .execute();
    return Number((result as any)[0]?.numDeletedRows ?? 0) > 0;
}

export async function getNativeRegistrationsForUser(userId: string): Promise<NativePushRegistrationTable[]> {
    const rows = await getKysely()
        .selectFrom("native_push_registration" as any)
        .selectAll()
        .where("userId", "=", userId)
        .execute();
    return rows as unknown as NativePushRegistrationTable[];
}

/**
 * Map a PizzaPi push payload to an ntfy JSON publish body (minus the per-device
 * `topic`, which the caller adds). Using the JSON publish API instead of HTTP
 * headers avoids `fetch` throwing on non-Latin-1 `title`/`message` values (emoji,
 * CJK session names) — header values must be ByteStrings, JSON bodies need not.
 * ntfy JSON fields: `title`, `message`, `priority` (1-5), `tags`, `click`.
 */
function buildNtfyPublish(payload: PushPayload): Record<string, unknown> {
    const priorityByType: Record<PushEventType, number> = {
        agent_needs_input: 4, // high
        agent_error: 4,
        agent_finished: 3, // default
        session_started: 2, // low
        session_ended: 3,
    };
    const fields: Record<string, unknown> = {
        // Prefer the session name so the Android client can render one
        // conversation per session (MessagingStyle groups by title + click URL).
        title: payload.sessionName ?? payload.title,
        message: payload.body,
        priority: priorityByType[payload.type] ?? 3,
        tags: ["pizza"],
    };
    // Click-through deep link to the relay WEB UI — NOT the ntfy server. The
    // device opens this on tap and the web UI routes `/#/sessions/<id>` to the
    // session viewer. Built from the relay's public base URL (PIZZAPI_BASE_URL);
    // omitted when that is unset rather than pointing at the wrong host.
    const baseUrl = (process.env.PIZZAPI_BASE_URL ?? "").replace(/\/+$/, "");
    if (payload.sessionId && baseUrl) {
        fields.click = `${baseUrl}/#/sessions/${payload.sessionId}`;
    }
    return fields;
}

/**
 * Publish a push payload to all native (ntfy) registrations for a user.
 * Never throws — failures are logged and stale registrations pruned. Caller
 * (sendPushToUser) treats this as best-effort alongside the Web Push fan-out.
 *
 * NOTE: native registrations have no per-subscription preference columns
 * (enabledEvents / suppressChildNotifications) today, so — unlike the Web Push
 * path — native currently delivers ALL events regardless of `isChildSession`.
 * The param is kept for signature parity; wire real suppression here once the
 * native registration schema grows those columns.
 */
async function sendNtfyToUser(userId: string, payload: PushPayload, isChildSession: boolean): Promise<void> {
    void isChildSession; // see note above: native has no suppression columns yet
    const cfg = ntfyConfig();
    if (!cfg.url) return;
    const registrations = await getNativeRegistrationsForUser(userId);
    if (registrations.length === 0) return;

    const fields = buildNtfyPublish(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.publishToken) {
        headers["Authorization"] = `Bearer ${cfg.publishToken}`;
    }
    const base = cfg.url.replace(/\/+$/, "");
    const staleIds: string[] = [];

    await Promise.allSettled(
        registrations.map(async (reg) => {
            try {
                // ntfy JSON publish: POST to the base URL with `topic` in the body.
                // 10s timeout so a hung ntfy instance can't block forever.
                const res = await fetch(base, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ topic: reg.topic, ...fields }),
                    signal: AbortSignal.timeout(10_000),
                });
                // 403/404 = topic forbidden/unknown → prune the registration.
                if (res.status === 403 || res.status === 404) {
                    staleIds.push(reg.id);
                } else if (!res.ok) {
                    log.error(`ntfy publish to topic ${reg.topic.slice(0, 16)}… failed: ${res.status}`);
                }
            } catch (err) {
                log.error("ntfy publish error:", err);
            }
        }),
    );

    if (staleIds.length > 0) {
        await getKysely()
            .deleteFrom("native_push_registration" as any)
            .where("id", "in", staleIds)
            .execute();
    }
}

export async function subscribePush(input: PushSubscribeInput): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Upsert — if the same endpoint exists for this user, replace it.
    await getKysely()
        .deleteFrom("push_subscription" as any)
        .where("userId", "=", input.userId)
        .where("endpoint", "=", input.endpoint)
        .execute();

    await getKysely()
        .insertInto("push_subscription" as any)
        .values({
            id,
            userId: input.userId,
            endpoint: input.endpoint,
            keys: JSON.stringify(input.keys),
            createdAt: now,
            enabledEvents: input.enabledEvents ?? "*",
            suppressChildNotifications: input.suppressChildNotifications ? 1 : 0,
        })
        .execute();

    return id;
}

export async function unsubscribePush(userId: string, endpoint: string): Promise<boolean> {
    const result = await getKysely()
        .deleteFrom("push_subscription" as any)
        .where("userId", "=", userId)
        .where("endpoint", "=", endpoint)
        .execute();

    return Number((result as any)[0]?.numDeletedRows ?? 0) > 0;
}

export async function unsubscribePushById(userId: string, subscriptionId: string): Promise<void> {
    await getKysely()
        .deleteFrom("push_subscription" as any)
        .where("userId", "=", userId)
        .where("id", "=", subscriptionId)
        .execute();
}

export async function getSubscriptionsForUser(userId: string): Promise<PushSubscriptionTable[]> {
    const rows = await getKysely()
        .selectFrom("push_subscription" as any)
        .selectAll()
        .where("userId", "=", userId)
        .execute();

    return rows as unknown as PushSubscriptionTable[];
}

export async function updateEnabledEvents(
    userId: string,
    endpoint: string,
    enabledEvents: string,
): Promise<void> {
    await getKysely()
        .updateTable("push_subscription" as any)
        .set({ enabledEvents })
        .where("userId", "=", userId)
        .where("endpoint", "=", endpoint)
        .execute();
}

/**
 * Returns the number of rows updated (0 if no matching subscription exists).
 * Callers should treat 0 as a 404 — the subscription endpoint is unknown.
 */
export async function updateSuppressChildNotifications(
    userId: string,
    endpoint: string,
    suppress: boolean,
): Promise<number> {
    const result = await getKysely()
        .updateTable("push_subscription" as any)
        .set({ suppressChildNotifications: suppress ? 1 : 0 })
        .where("userId", "=", userId)
        .where("endpoint", "=", endpoint)
        .execute();
    return Number((result as any)[0]?.numUpdatedRows ?? 0);
}

// ── Send push notifications ─────────────────────────────────────────────────

export type PushEventType =
    | "agent_finished"
    | "agent_error"
    | "agent_needs_input"
    | "session_started"
    | "session_ended";

export interface PushPayload {
    type: PushEventType;
    title: string;
    body: string;
    /** Session ID (for click-through navigation) */
    sessionId?: string;
    /** Human-readable session name (used as the conversation title on native) */
    sessionName?: string;
    /** Arbitrary extra data */
    data?: Record<string, unknown>;
    /** Notification actions (MC options for "agent_needs_input") */
    actions?: Array<{ action: string; title: string; type?: "button" | "text"; placeholder?: string }>;
}

function isEventEnabled(enabledEvents: string, eventType: PushEventType): boolean {
    if (enabledEvents === "*") return true;
    const events = enabledEvents.split(",").map((s) => s.trim());
    return events.includes(eventType);
}

/**
 * Send a push notification to all subscriptions for a given user.
 * Silently removes subscriptions that are no longer valid (410 Gone).
 *
 * @param isChildSession - When true, subscriptions with suppressChildNotifications
 *   enabled will not receive this notification.
 */
export async function sendPushToUser(userId: string, payload: PushPayload, isChildSession = false): Promise<void> {
    const subscriptions = await getSubscriptionsForUser(userId);

    // Native (ntfy) fan-out runs regardless of Web Push subscriptions — a user
    // may have only the native app registered, with zero browser subs. Kick it
    // off WITHOUT awaiting here so a slow/hung ntfy instance can't delay browser
    // delivery; it settles alongside the Web Push sends below.
    const ntfyPromise = sendNtfyToUser(userId, payload, isChildSession).catch((err) => {
        log.error("ntfy fan-out failed:", err);
    });

    const payloadStr = JSON.stringify(payload);
    const staleIds: string[] = [];

    await Promise.allSettled([
        ntfyPromise,
        ...subscriptions.map(async (sub) => {
            if (!isEventEnabled(sub.enabledEvents, payload.type)) return;
            if (isChildSession && sub.suppressChildNotifications) return;

            let keys: { p256dh: string; auth: string };
            try {
                keys = JSON.parse(sub.keys);
            } catch {
                staleIds.push(sub.id);
                return;
            }

            const pushSub: webpush.PushSubscription = {
                endpoint: sub.endpoint,
                keys,
            };

            try {
                await webpush.sendNotification(pushSub, payloadStr);
            } catch (err: any) {
                if (err?.statusCode === 410 || err?.statusCode === 404) {
                    // Subscription expired or unregistered — clean up
                    staleIds.push(sub.id);
                } else {
                    log.error(`Failed to send to ${sub.endpoint.slice(0, 60)}…:`, err?.statusCode ?? err?.message);
                }
            }
        }),
    ]);

    // Remove stale subscriptions
    if (staleIds.length > 0) {
        await getKysely()
            .deleteFrom("push_subscription" as any)
            .where("id", "in", staleIds)
            .execute();
    }
}

/**
 * Convenience: notify a user that their agent finished working.
 */
export function notifyAgentFinished(
    userId: string,
    sessionId: string,
    sessionName?: string | null,
    isChildSession = false,
    replyText?: string,
): void {
    const label = sessionName ?? sessionId.slice(0, 8);
    const reply = replyText?.trim();
    void sendPushToUser(userId, {
        type: "agent_finished",
        title: "Agent finished",
        body: reply
            ? (reply.length > 300 ? reply.slice(0, 297) + "…" : reply)
            : `Your agent in "${label}" has finished its task.`,
        sessionId,
        sessionName: label,
    }, isChildSession).catch((err) => {
        log.error("notifyAgentFinished failed:", err);
    });
}

/**
 * Convenience: notify a user that the agent needs input.
 * When options are provided, the push notification includes action buttons
 * so the user can answer directly from the notification.
 */
export function notifyAgentNeedsInput(
    userId: string,
    sessionId: string,
    question?: string,
    sessionName?: string | null,
    options?: string[],
    toolCallId?: string,
    isChildSession = false,
): void {
    const label = sessionName ?? sessionId.slice(0, 8);
    const body = question
        ? `Agent in "${label}" asks: ${question.slice(0, 120)}`
        : `Agent in "${label}" is waiting for your input.`;

    // Build notification actions from MC options.
    // Platforms support max 2–3 buttons; we use up to 2 option buttons + 1 inline reply.
    const actions: PushPayload["actions"] = [];
    if (options && options.length > 0) {
        // Filter out agent "Type your own" entries
        const filtered = options.filter(
            (o) => o.toLowerCase().replace(/[^a-z]/g, "") !== "typeyourown",
        );
        // Add up to 2 option buttons
        for (let i = 0; i < Math.min(filtered.length, 2); i++) {
            actions.push({
                action: `option-${i}`,
                title: filtered[i].length > 30 ? filtered[i].slice(0, 28) + "…" : filtered[i],
                type: "button",
            });
        }
        // Add inline reply action
        actions.push({
            action: "reply",
            title: "✏️ Reply",
            type: "text",
            placeholder: "Type your answer…",
        });
    }

    void sendPushToUser(userId, {
        type: "agent_needs_input",
        title: "Input needed",
        body,
        sessionId,
        sessionName: label,
        actions: actions.length > 0 ? actions : undefined,
        data: {
            ...(options && options.length > 0 ? { options } : {}),
            ...(toolCallId ? { toolCallId } : {}),
        },
    }, isChildSession).catch((err) => {
        log.error("notifyAgentNeedsInput failed:", err);
    });
}

/**
 * Convenience: notify a user that an error occurred.
 */
export function notifyAgentError(userId: string, sessionId: string, errorMessage?: string, sessionName?: string | null, isChildSession = false): void {
    const label = sessionName ?? sessionId.slice(0, 8);
    const body = errorMessage
        ? `Error in "${label}": ${errorMessage.slice(0, 120)}`
        : `An error occurred in session "${label}".`;
    void sendPushToUser(userId, {
        type: "agent_error",
        title: "Agent error",
        body,
        sessionId,
        sessionName: label,
    }, isChildSession).catch((err) => {
        log.error("notifyAgentError failed:", err);
    });
}
