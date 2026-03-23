import webpush from "web-push";
import { getKysely } from "./auth.js";

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
        console.warn("[push] ⚠️  VAPID keys are set but invalid (private key must be 32 bytes, public key 65 bytes when base64url-decoded).");
        console.warn("[push]    Falling back to ephemeral keys.");
    }
    const generated = webpush.generateVAPIDKeys();
    vapidPublicKey = generated.publicKey;
    vapidPrivateKey = generated.privateKey;
    console.warn("[push] ⚠️  No valid VAPID keys configured — using ephemeral keys.");
    console.warn("[push]    Push subscriptions will break on every server restart.");
    console.warn("[push]    To fix, add these to your environment:");
    console.warn(`[push]    VAPID_PUBLIC_KEY=${vapidPublicKey}`);
    console.warn(`[push]    VAPID_PRIVATE_KEY=${vapidPrivateKey}`);
    console.warn(`[push]    VAPID_SUBJECT=mailto:your@email.com`);
}

const vapidSubject = process.env.VAPID_SUBJECT ?? "mailto:admin@pizzapi.local";

webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

export function getVapidPublicKey(): string {
    return vapidPublicKey;
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

export async function updateSuppressChildNotifications(
    userId: string,
    endpoint: string,
    suppress: boolean,
): Promise<void> {
    await getKysely()
        .updateTable("push_subscription" as any)
        .set({ suppressChildNotifications: suppress ? 1 : 0 })
        .where("userId", "=", userId)
        .where("endpoint", "=", endpoint)
        .execute();
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
    if (subscriptions.length === 0) return;

    const payloadStr = JSON.stringify(payload);
    const staleIds: string[] = [];

    await Promise.allSettled(
        subscriptions.map(async (sub) => {
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
                    console.error(`[push] Failed to send to ${sub.endpoint.slice(0, 60)}…:`, err?.statusCode ?? err?.message);
                }
            }
        }),
    );

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
export function notifyAgentFinished(userId: string, sessionId: string, sessionName?: string | null, isChildSession = false): void {
    const label = sessionName ?? sessionId.slice(0, 8);
    void sendPushToUser(userId, {
        type: "agent_finished",
        title: "Agent finished",
        body: `Your agent in "${label}" has finished its task.`,
        sessionId,
    }, isChildSession).catch((err) => {
        console.error("[push] notifyAgentFinished failed:", err);
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
        actions: actions.length > 0 ? actions : undefined,
        data: {
            ...(options && options.length > 0 ? { options } : {}),
            ...(toolCallId ? { toolCallId } : {}),
        },
    }, isChildSession).catch((err) => {
        console.error("[push] notifyAgentNeedsInput failed:", err);
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
    }, isChildSession).catch((err) => {
        console.error("[push] notifyAgentError failed:", err);
    });
}
