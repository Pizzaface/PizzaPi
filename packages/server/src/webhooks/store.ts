/**
 * Webhook store — SQLite-backed webhook registration and CRUD.
 *
 * Uses the same Kysely pattern as packages/server/src/sessions/store.ts.
 * Each webhook has an HMAC secret for validating inbound fire requests.
 *
 * Every webhook fire spawns a new session on the user's runner.
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
    secret: string;
    /** Parsed event filter array (or null if no filter). */
    eventFilter: string[] | null;
    /** Source type — e.g. "custom", "slack", "cron", etc. */
    source: string;
    /** Working directory for spawned sessions. */
    cwd: string | null;
    /** Custom prompt sent to the spawned session. */
    prompt: string | null;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface CreateWebhookInput {
    userId: string;
    name: string;
    eventFilter?: string[] | null;
    source: string;
    cwd?: string | null;
    prompt?: string | null;
}

export interface UpdateWebhookInput {
    name?: string;
    eventFilter?: string[] | null;
    source?: string;
    cwd?: string | null;
    prompt?: string | null;
    enabled?: boolean;
}

// ── Schema ────────────────────────────────────────────────────────────────────

export async function ensureWebhookTable(): Promise<void> {
    const db = getKysely();

    await db.schema
        .createTable("webhook")
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("userId", "text", (col) => col.notNull())
        .addColumn("name", "text", (col) => col.notNull())
        .addColumn("secret", "text", (col) => col.notNull())
        .addColumn("eventFilter", "text")
        .addColumn("source", "text", (col) => col.notNull())
        .addColumn("cwd", "text")
        .addColumn("prompt", "text")
        .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("updatedAt", "text", (col) => col.notNull())
        .execute();

    await db.schema
        .createIndex("webhook_user_idx")
        .ifNotExists()
        .on("webhook")
        .column("userId")
        .execute();

    // ── Migrations for existing tables ────────────────────────────────────
    // Add cwd + prompt columns if they don't exist yet (added after initial schema).
    // Drop targetSessionId if it still exists from the old schema.
    // Each ALTER is wrapped individually — if the column already exists (or
    // doesn't exist for DROP), SQLite throws and we catch silently.
    try { await db.schema.alterTable("webhook").addColumn("cwd", "text").execute(); log.info("Added 'cwd' column."); } catch { /* already exists */ }
    try { await db.schema.alterTable("webhook").addColumn("prompt", "text").execute(); log.info("Added 'prompt' column."); } catch { /* already exists */ }
    try { await db.schema.alterTable("webhook").dropColumn("targetSessionId").execute(); log.info("Dropped legacy 'targetSessionId' column."); } catch { /* already gone */ }

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
    secret: string;
    eventFilter: string | null;
    source: string;
    cwd: string | null;
    prompt: string | null;
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
        secret: row.secret,
        eventFilter,
        source: row.source,
        cwd: row.cwd ?? null,
        prompt: row.prompt ?? null,
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
            secret,
            eventFilter: input.eventFilter ? JSON.stringify(input.eventFilter) : null,
            source: input.source,
            cwd: input.cwd ?? null,
            prompt: input.prompt ?? null,
            enabled: 1,
            createdAt: now,
            updatedAt: now,
        })
        .execute();

    return {
        id,
        userId: input.userId,
        name: input.name,
        secret,
        eventFilter: input.eventFilter ?? null,
        source: input.source,
        cwd: input.cwd ?? null,
        prompt: input.prompt ?? null,
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

    return row ? rowToWebhook(row as any) : null;
}

export async function listWebhooksForUser(userId: string): Promise<Webhook[]> {
    const rows = await getKysely()
        .selectFrom("webhook")
        .selectAll()
        .where("userId", "=", userId)
        .orderBy("createdAt", "desc")
        .execute();

    return rows.map((r) => rowToWebhook(r as any));
}

export async function updateWebhook(
    id: string,
    userId: string,
    input: UpdateWebhookInput,
): Promise<Webhook | null> {
    const now = new Date().toISOString();

    const updates: Record<string, unknown> = { updatedAt: now };
    if (input.name !== undefined) updates.name = input.name;
    if (input.source !== undefined) updates.source = input.source;
    if (input.enabled !== undefined) updates.enabled = input.enabled ? 1 : 0;
    if (input.eventFilter !== undefined) {
        updates.eventFilter = input.eventFilter ? JSON.stringify(input.eventFilter) : null;
    }
    if (input.cwd !== undefined) updates.cwd = input.cwd;
    if (input.prompt !== undefined) updates.prompt = input.prompt;

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
