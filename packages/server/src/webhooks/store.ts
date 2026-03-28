/**
 * Webhook store — SQLite-backed webhook registration and CRUD.
 *
 * Uses the same Kysely pattern as packages/server/src/sessions/store.ts.
 * Each webhook has an HMAC secret for validating inbound fire requests.
 */

import { getKysely } from "../auth.js";
import { createLogger } from "@pizzapi/tools";
import { randomUUID, randomBytes } from "crypto";

const log = createLogger("webhooks/store");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Webhook {
    id: string;
    userId: string;
    name: string;
    targetSessionId: string | null;
    secret: string;
    /** Parsed event filter array (or null if no filter). */
    eventFilter: string[] | null;
    /** Source type — "github", "slack", "cron", "custom", etc. */
    source: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface CreateWebhookInput {
    userId: string;
    name: string;
    targetSessionId?: string | null;
    eventFilter?: string[] | null;
    source: string;
}

export interface UpdateWebhookInput {
    name?: string;
    targetSessionId?: string | null;
    eventFilter?: string[] | null;
    source?: string;
    enabled?: boolean;
}

// ── Schema ────────────────────────────────────────────────────────────────────

export async function ensureWebhookTable(): Promise<void> {
    await getKysely().schema
        .createTable("webhook")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("name", "text", (col) => col.notNull())
        .addColumn("targetSessionId", "text")
        .addColumn("secret", "text", (col) => col.notNull())
        .addColumn("eventFilter", "text")
        .addColumn("source", "text", (col) => col.notNull())
        .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("updatedAt", "text", (col) => col.notNull())
        .execute();

    await getKysely().schema
        .createIndex("webhook_user_idx")
        .ifNotExists()
        .on("webhook")
        .column("userId")
        .execute();

    log.info("Webhook table ready.");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateSecret(): string {
    return randomBytes(32).toString("hex");
}

function rowToWebhook(row: {
    id: string;
    userId: string;
    name: string;
    targetSessionId: string | null;
    secret: string;
    eventFilter: string | null;
    source: string;
    enabled: number;
    createdAt: string;
    updatedAt: string;
}): Webhook {
    let eventFilter: string[] | null = null;
    if (row.eventFilter) {
        try {
            eventFilter = JSON.parse(row.eventFilter);
        } catch {
            eventFilter = null;
        }
    }
    return {
        id: row.id,
        userId: row.userId,
        name: row.name,
        targetSessionId: row.targetSessionId,
        secret: row.secret,
        eventFilter,
        source: row.source,
        enabled: row.enabled === 1,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createWebhook(input: CreateWebhookInput): Promise<Webhook> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const secret = generateSecret();

    await getKysely()
        .insertInto("webhook")
        .values({
            id,
            userId: input.userId,
            name: input.name,
            targetSessionId: input.targetSessionId ?? null,
            secret,
            eventFilter: input.eventFilter ? JSON.stringify(input.eventFilter) : null,
            source: input.source,
            enabled: 1,
            createdAt: now,
            updatedAt: now,
        })
        .execute();

    return {
        id,
        userId: input.userId,
        name: input.name,
        targetSessionId: input.targetSessionId ?? null,
        secret,
        eventFilter: input.eventFilter ?? null,
        source: input.source,
        enabled: true,
        createdAt: now,
        updatedAt: now,
    };
}

export async function getWebhook(id: string): Promise<Webhook | null> {
    const row = await getKysely()
        .selectFrom("webhook")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();

    return row ? rowToWebhook(row) : null;
}

export async function listWebhooksForUser(userId: string): Promise<Webhook[]> {
    const rows = await getKysely()
        .selectFrom("webhook")
        .selectAll()
        .where("userId", "=", userId)
        .orderBy("createdAt", "desc")
        .execute();

    return rows.map(rowToWebhook);
}

export async function updateWebhook(
    id: string,
    userId: string,
    input: UpdateWebhookInput,
): Promise<Webhook | null> {
    const now = new Date().toISOString();

    const updates: Record<string, unknown> = { updatedAt: now };
    if (input.name !== undefined) updates.name = input.name;
    if (input.targetSessionId !== undefined) updates.targetSessionId = input.targetSessionId;
    if (input.source !== undefined) updates.source = input.source;
    if (input.enabled !== undefined) updates.enabled = input.enabled ? 1 : 0;
    if (input.eventFilter !== undefined) {
        updates.eventFilter = input.eventFilter ? JSON.stringify(input.eventFilter) : null;
    }

    const result = await getKysely()
        .updateTable("webhook")
        .set(updates)
        .where("id", "=", id)
        .where("userId", "=", userId)
        .execute();

    if ((result[0]?.numUpdatedRows ?? 0n) === 0n) return null;

    return getWebhook(id);
}

export async function deleteWebhook(id: string, userId: string): Promise<boolean> {
    const result = await getKysely()
        .deleteFrom("webhook")
        .where("id", "=", id)
        .where("userId", "=", userId)
        .execute();

    return (result[0]?.numDeletedRows ?? 0n) > 0n;
}

/**
 * Find the most recent active relay session for a user.
 * Used when webhook has no targetSessionId.
 */
export async function getMostRecentActiveSessionId(userId: string): Promise<string | null> {
    const row = await getKysely()
        .selectFrom("relay_session")
        .select("id")
        .where("userId", "=", userId)
        .where("endedAt", "is", null)
        .orderBy("lastActiveAt", "desc")
        .limit(1)
        .executeTakeFirst();

    return row?.id ?? null;
}
