import webpush from "web-push";
import { kysely } from "./auth.js";

// ── VAPID configuration ─────────────────────────────────────────────────────
//
// Provide VAPID keys via env vars. If not set, generate ephemeral ones
// (fine for dev, but push subscriptions won't survive server restarts).

let vapidPublicKey = process.env.VAPID_PUBLIC_KEY ?? "";
let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY ?? "";

if (!vapidPublicKey || !vapidPrivateKey) {
    const generated = webpush.generateVAPIDKeys();
    vapidPublicKey = generated.publicKey;
    vapidPrivateKey = generated.privateKey;
    console.warn("[push] ⚠️  No VAPID keys configured — using ephemeral keys.");
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
}

export async function ensurePushSubscriptionTable(): Promise<void> {
    await kysely.schema
        .createTable("push_subscription")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("endpoint", "text", (col) => col.notNull())
        .addColumn("keys", "text", (col) => col.notNull())
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("enabledEvents", "text", (col) => col.notNull().defaultTo("*"))
        .execute();

    await kysely.schema
        .createIndex("push_subscription_user_idx")
        .ifNotExists()
        .on("push_subscription")
        .column("userId")
        .execute();

    await kysely.schema
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
}

export async function subscribePush(input: PushSubscribeInput): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Upsert — if the same endpoint exists for this user, replace it.
    await kysely
        .deleteFrom("push_subscription" as any)
        .where("userId", "=", input.userId)
        .where("endpoint", "=", input.endpoint)
        .execute();

    await kysely
        .insertInto("push_subscription" as any)
        .values({
            id,
            userId: input.userId,
            endpoint: input.endpoint,
            keys: JSON.stringify(input.keys),
            createdAt: now,
            enabledEvents: input.enabledEvents ?? "*",
        })
        .execute();

    return id;
}

export async function unsubscribePush(userId: string, endpoint: string): Promise<boolean> {
    const result = await kysely
        .deleteFrom("push_subscription" as any)
        .where("userId", "=", userId)
        .where("endpoint", "=", endpoint)
        .execute();

    return (result as any)[0]?.numDeletedRows > 0 || true;
}

export async function unsubscribePushById(userId: string, subscriptionId: string): Promise<void> {
    await kysely
        .deleteFrom("push_subscription" as any)
        .where("userId", "=", userId)
        .where("id", "=", subscriptionId)
        .execute();
}

export async function getSubscriptionsForUser(userId: string): Promise<PushSubscriptionTable[]> {
    const rows = await kysely
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
    await kysely
        .updateTable("push_subscription" as any)
        .set({ enabledEvents })
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
}

function isEventEnabled(enabledEvents: string, eventType: PushEventType): boolean {
    if (enabledEvents === "*") return true;
    const events = enabledEvents.split(",").map((s) => s.trim());
    return events.includes(eventType);
}

/**
 * Send a push notification to all subscriptions for a given user.
 * Silently removes subscriptions that are no longer valid (410 Gone).
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
    const subscriptions = await getSubscriptionsForUser(userId);
    if (subscriptions.length === 0) return;

    const payloadStr = JSON.stringify(payload);
    const staleIds: string[] = [];

    await Promise.allSettled(
        subscriptions.map(async (sub) => {
            if (!isEventEnabled(sub.enabledEvents, payload.type)) return;

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
        await kysely
            .deleteFrom("push_subscription" as any)
            .where("id", "in", staleIds)
            .execute();
    }
}

/**
 * Convenience: notify a user that their agent finished working.
 */
export function notifyAgentFinished(userId: string, sessionId: string, sessionName?: string | null): void {
    const label = sessionName ?? sessionId.slice(0, 8);
    void sendPushToUser(userId, {
        type: "agent_finished",
        title: "Agent finished",
        body: `Your agent in "${label}" has finished its task.`,
        sessionId,
    }).catch((err) => {
        console.error("[push] notifyAgentFinished failed:", err);
    });
}

/**
 * Convenience: notify a user that the agent needs input.
 */
export function notifyAgentNeedsInput(userId: string, sessionId: string, question?: string, sessionName?: string | null): void {
    const label = sessionName ?? sessionId.slice(0, 8);
    const body = question
        ? `Agent in "${label}" asks: ${question.slice(0, 120)}`
        : `Agent in "${label}" is waiting for your input.`;
    void sendPushToUser(userId, {
        type: "agent_needs_input",
        title: "Input needed",
        body,
        sessionId,
    }).catch((err) => {
        console.error("[push] notifyAgentNeedsInput failed:", err);
    });
}

/**
 * Convenience: notify a user that an error occurred.
 */
export function notifyAgentError(userId: string, sessionId: string, errorMessage?: string, sessionName?: string | null): void {
    const label = sessionName ?? sessionId.slice(0, 8);
    const body = errorMessage
        ? `Error in "${label}": ${errorMessage.slice(0, 120)}`
        : `An error occurred in session "${label}".`;
    void sendPushToUser(userId, {
        type: "agent_error",
        title: "Agent error",
        body,
        sessionId,
    }).catch((err) => {
        console.error("[push] notifyAgentError failed:", err);
    });
}
