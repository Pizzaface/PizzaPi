import { mkdir, rm, access } from "node:fs/promises";
import path from "node:path";
import { getKysely } from "../auth.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("attachments");

export interface StoredAttachment {
    attachmentId: string;
    sessionId: string;
    ownerUserId: string;
    uploaderUserId: string;
    filename: string;
    mimeType: string;
    size: number;
    createdAt: string;
    expiresAt: string;
    expiresAtMs?: number;
    filePath: string;
}

const DEFAULT_ATTACHMENT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024;
/** Extracted images (from session state) persist for 24 hours. */
const EXTRACTED_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

function attachmentTtlMs(): number {
    const raw = Number.parseInt(process.env.PIZZAPI_ATTACHMENT_TTL_MS ?? "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ATTACHMENT_TTL_MS;
}

export function attachmentMaxFileSizeBytes(): number {
    const raw = Number.parseInt(process.env.PIZZAPI_ATTACHMENT_MAX_FILE_SIZE_BYTES ?? "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_FILE_SIZE_BYTES;
}

const uploadRoot = path.resolve(process.env.PIZZAPI_ATTACHMENT_DIR ?? path.join(process.cwd(), ".pizzapi", "uploads"));

const attachments = new Map<string, StoredAttachment>();

/**
 * Tracks all session IDs that reference each extracted (deduplicated) attachment.
 * Regular uploads are 1:1 (session → attachment), but extracted images can be
 * shared across sessions when the same user produces identical image content.
 * The sweep/rehydration logic uses this to avoid deleting images that are still
 * referenced by any durable session.
 */
const extractedImageSessionRefs = new Map<string, Set<string>>();

export function sanitizeFilename(filename: string): string {
    return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Strip control characters (0x00–0x1F and 0x7F) from a filename before
 * storing it.  The full Unicode name is preserved (non-ASCII printable chars
 * are kept) — only raw control characters that would cause Bun to throw when
 * building HTTP response headers are removed.
 */
export function sanitizeStoredFilename(filename: string): string {
    // eslint-disable-next-line no-control-regex
    return filename.replace(/[\x00-\x1F\x7F]/g, "_");
}

export async function storeSessionAttachment(input: {
    sessionId: string;
    ownerUserId: string;
    uploaderUserId: string;
    file: File;
}): Promise<StoredAttachment> {
    const { sessionId, ownerUserId, uploaderUserId, file } = input;

    const attachmentId = crypto.randomUUID();
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + attachmentTtlMs();

    const safeName = sanitizeFilename(file.name || `attachment-${attachmentId}`);
    const targetPath = path.join(uploadRoot, `${attachmentId}-${safeName}`);

    await mkdir(uploadRoot, { recursive: true });
    const bytes = new Uint8Array(await file.arrayBuffer());
    await Bun.write(targetPath, bytes);

    const record: StoredAttachment = {
        attachmentId,
        sessionId,
        ownerUserId,
        uploaderUserId,
        filename: sanitizeStoredFilename(file.name || safeName),
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        filePath: targetPath,
    };

    try {
        await persistUploadedAttachment(record);
    } catch (err) {
        try {
            await rm(targetPath, { force: true });
        } catch (cleanupErr) {
            log.error("Failed to clean up uploaded attachment after persistence failure:", cleanupErr);
        }
        throw err;
    }
    attachments.set(attachmentId, record);
    return record;
}

export async function getStoredAttachment(attachmentId: string): Promise<StoredAttachment | null> {
    const record = attachments.get(attachmentId);
    if (!record) return null;

    const nowMs = Date.now();
    const expiresAtMs = record.expiresAtMs ?? Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        // For extracted images (uploaderUserId === "system"), check whether this
        // attachment is referenced by a durable (pinned/non-ephemeral) session
        // before deleting.  Without this, a viewer requesting an expired-but-durable
        // attachment races the sweep and permanently removes it on read.
        if (record.uploaderUserId === "system") {
            const durableSessionIds = await getDurableSessionIds();
            if (hasAnyDurableSessionRef(attachmentId, record.sessionId, durableSessionIds)) {
                // Renew the TTL instead of deleting.
                const refreshed = nowMs + EXTRACTED_IMAGE_TTL_MS;
                record.expiresAt = new Date(refreshed).toISOString();
                record.expiresAtMs = refreshed;
                void persistExtractedAttachment(record).catch(() => {});
                return record;
            }
        }
        void deleteStoredAttachment(attachmentId).catch((err) => {
            log.error("Background delete failed for attachment:", attachmentId, err);
        });
        return null;
    }

    return record;
}

export async function deleteStoredAttachment(attachmentId: string): Promise<void> {
    const record = attachments.get(attachmentId);
    if (!record) return;
    // P1 fix: DB deletes FIRST — if any reject, we leave the in-memory entry intact
    // so subsequent prune/sweep calls can retry. File removal is best-effort after.
    await Promise.all([
        removePersistedAttachment(attachmentId),
        removePersistedUploadedAttachment(attachmentId),
        removePersistedSessionRefs(attachmentId),
    ]);
    // Only remove from memory after persistence deletes succeed.
    attachments.delete(attachmentId);
    extractedImageSessionRefs.delete(attachmentId);
    // Best-effort file rm: awaited so callers (and tests) see a consistent final state,
    // but errors are caught so a missing file never breaks the deletion contract.
    // ponytail: try/catch over fire-and-forget — same best-effort semantics, deterministic.
    try {
        await rm(record.filePath, { force: true });
    } catch (err) {
        log.error("Failed to delete attachment file:", err);
    }
}

// ── Extracted image storage ──────────────────────────────────────────────────
// Used by strip-images.ts to offload inline base64 images from session state
// payloads. Uses the same storage mechanism as uploads but with a longer TTL
// and a deterministic attachment ID (passed in rather than generated).

/**
 * Normalize the MIME type of an extracted image.
 *
 * storeExtractedImage is explicitly for images, but the MIME type arrives
 * from agent session state payloads (LLM tool output) and is
 * attacker-influenced.  Anything that is not a plain image/* type falls back
 * to a non-renderable type so it can never be served as e.g. text/html.
 */
export function normalizeExtractedImageMimeType(mimeType: string): string {
    return /^image\/[a-z0-9.+-]+$/i.test(mimeType.split(";")[0]?.trim() ?? "")
        ? mimeType
        : "application/octet-stream";
}

/**
 * Store base64 image data extracted from a session state payload.
 * The attachmentId is pre-generated by the caller (strip-images.ts).
 */
export async function storeExtractedImage(input: {
    attachmentId: string;
    sessionId: string;
    ownerUserId: string;
    mimeType: string;
    base64Data: string;
}): Promise<StoredAttachment> {
    const { attachmentId, sessionId, ownerUserId, base64Data } = input;
    const mimeType = normalizeExtractedImageMimeType(input.mimeType);

    // Deduplicate: if this content-hashed ID already exists, just refresh its
    // expiry and return the existing record — no need to re-decode/write.
    const existing = attachments.get(attachmentId);
    if (existing) {
        const refreshedExpiry = Date.now() + EXTRACTED_IMAGE_TTL_MS;
        existing.expiresAt = new Date(refreshedExpiry).toISOString();
        existing.expiresAtMs = refreshedExpiry;
        // Track the latest session on the record (for backward compat / display)
        existing.sessionId = sessionId;
        // Also track ALL sessions referencing this attachment so sweep doesn't
        // delete an image that's still used by a durable session.
        addSessionRef(attachmentId, sessionId);
        await persistExtractedAttachment(existing).catch((err) => {
            log.error("Failed to persist refreshed expiry:", err);
        });
        await persistSessionRef(attachmentId, sessionId).catch(() => {});
        return existing;
    }

    // Strip data-URI prefix (e.g. "data:image/png;base64,") before decoding.
    // Upstream image payloads may arrive in data-URI form.
    const rawB64 = base64Data.includes(",") && base64Data.startsWith("data:")
        ? base64Data.slice(base64Data.indexOf(",") + 1)
        : base64Data;
    const bytes = Buffer.from(rawB64, "base64");
    const VALID_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico"]);
    const rawExt = mimeType.split("/").pop()?.split(";")[0]?.trim().toLowerCase() ?? "png";
    const ext = VALID_IMAGE_EXTS.has(rawExt) ? rawExt : "bin";
    const filename = `extracted-${attachmentId}.${ext}`;
    const targetPath = path.join(uploadRoot, filename);

    await mkdir(uploadRoot, { recursive: true });
    await Bun.write(targetPath, bytes);

    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + EXTRACTED_IMAGE_TTL_MS;

    const record: StoredAttachment = {
        attachmentId,
        sessionId,
        ownerUserId,
        uploaderUserId: "system",
        filename,
        mimeType,
        size: bytes.length,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        filePath: targetPath,
    };

    attachments.set(attachmentId, record);
    addSessionRef(attachmentId, sessionId);
    // Await both persists so the record and session reference are durably written
    // before the caller can store the attachment URL in session state. Without
    // this, a crash between the file-write and the SQLite commit leaves dangling
    // /api/attachments/:id URLs in snapshots that can never be rehydrated.
    await persistExtractedAttachment(record).catch((err) => {
        log.error("Failed to persist extracted attachment:", err);
    });
    await persistSessionRef(attachmentId, sessionId).catch(() => {});
    return record;
}

/**
 * Get the URL path for an extracted image attachment.
 * This is used by strip-images.ts to build the replacement URL.
 */
export function getExtractedImageUrl(attachmentId: string): string {
    return `/api/attachments/${attachmentId}`;
}

export async function sweepExpiredAttachments(nowMs: number = Date.now()): Promise<void> {
    // Batch-load durable session IDs so we can skip deletion for their attachments.
    const durableSessionIds = await getDurableSessionIds();

    const removals: Promise<void>[] = [];
    for (const [attachmentId, record] of attachments.entries()) {
        const expiresAtMs = record.expiresAtMs ?? Date.parse(record.expiresAt);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) continue;

        // If the attachment is referenced by ANY durable (pinned or non-ephemeral)
        // session that is still alive, renew the TTL instead of deleting.
        if (record.uploaderUserId === "system" && hasAnyDurableSessionRef(attachmentId, record.sessionId, durableSessionIds)) {
            const refreshed = nowMs + EXTRACTED_IMAGE_TTL_MS;
            record.expiresAt = new Date(refreshed).toISOString();
            record.expiresAtMs = refreshed;
            void persistExtractedAttachment(record).catch(() => {});
            continue;
        }

        removals.push(deleteStoredAttachment(attachmentId));
    }
    await Promise.all(removals);
}

/**
 * Delete attachments owned exclusively by the given pruned (expired/ephemeral) sessions.
 *
 * Ordering invariant: in-memory state (attachments map, extractedImageSessionRefs) is
 * ONLY mutated AFTER all awaited DB deletes resolve. On rejection, all in-memory state
 * is left intact so a subsequent pruneSessionAttachments call can retry.
 *
 * - Single-session uploads (`uploaderUserId !== "system"`): deleted outright via
 *   deleteStoredAttachment (DB-first, memory-after).
 * - Extracted/shared images: if no durable session still references them, deleted via
 *   deleteStoredAttachment (same DB-first ordering). If a durable ref exists, only the
 *   pruned session ref is removed — DB junction row first, then in-memory ref.
 */
export async function pruneSessionAttachments(prunedSessionIds: string[]): Promise<void> {
    if (prunedSessionIds.length === 0) return;

    const prunedSet = new Set(prunedSessionIds);
    const durableSessionIds = await getDurableSessionIds();

    // 1. Delete single-session uploads owned by pruned sessions.
    //    deleteStoredAttachment is DB-first: if it rejects, in-memory entry is preserved.
    const uploadsToDelete: string[] = [];
    for (const [attachmentId, record] of attachments) {
        if (prunedSet.has(record.sessionId) && record.uploaderUserId !== "system") {
            uploadsToDelete.push(attachmentId);
        }
    }
    for (const id of uploadsToDelete) {
        await deleteStoredAttachment(id);
    }

    // 2. Classify extracted images WITHOUT touching in-memory state yet.
    //    We must not mutate extractedImageSessionRefs until DB deletes succeed.
    const extractedToDelete: string[] = []; // no durable refs → full delete
    const extractedToKeep: string[] = [];   // has durable refs → prune only the pruned-session refs
    for (const [attachmentId, refs] of extractedImageSessionRefs) {
        const hasPrunedRef = [...prunedSet].some((sid) => refs.has(sid));
        if (!hasPrunedRef) continue;
        const hasDurableRef = [...refs].some((sid) => durableSessionIds.has(sid));
        if (hasDurableRef) {
            extractedToKeep.push(attachmentId);
        } else {
            extractedToDelete.push(attachmentId);
        }
    }

    // 3. Full-delete for extracted images with no durable refs.
    //    deleteStoredAttachment is the single chokepoint: it awaits all DB deletes
    //    before removing the attachments map entry AND extractedImageSessionRefs entry.
    //    On rejection it leaves both intact → retry rediscovers them.
    for (const id of extractedToDelete) {
        await deleteStoredAttachment(id);
    }

    // 4. Partial-delete for kept images: remove only the pruned session refs.
    //    DB junction rows first, in-memory mutation only after they resolve.
    //    On rejection, in-memory refs are left intact for the same retry guarantee.
    if (extractedToKeep.length > 0) {
        await getKysely()
            .deleteFrom("extracted_attachment_session" as any)
            .where("attachmentId", "in", extractedToKeep)
            .where("sessionId", "in", prunedSessionIds)
            .execute();
        // DB deletes resolved — now safe to mutate in-memory refs.
        for (const attachmentId of extractedToKeep) {
            const refs = extractedImageSessionRefs.get(attachmentId);
            if (refs) {
                for (const sid of prunedSet) refs.delete(sid);
            }
        }
    }
}

/**
 * Return the set of session IDs that are pinned or non-ephemeral (and not yet expired).
 * Used by the sweep to avoid deleting extracted images that are still reachable.
 */
async function getDurableSessionIds(): Promise<Set<string>> {
    const nowIso = new Date().toISOString();
    const rows = await getKysely()
        .selectFrom("relay_session")
        .select("id")
        .where((eb) =>
            eb.or([
                eb("isPinned", "=", 1),
                eb.and([
                    eb("isEphemeral", "=", 0),
                    eb.or([
                        eb("expiresAt", "is", null),
                        eb("expiresAt", ">", nowIso),
                    ]),
                ]),
            ]),
        )
        .execute();
    return new Set(rows.map((r) => r.id));
}

// ── Session-ref helpers (in-memory) ──────────────────────────────────────────

/**
 * @internal Exposed for tests only — do not call from production code.
 * Returns read-only views of both in-memory maps so tests can assert
 * that state survives a DB-delete failure.
 */
export function _testGetExtractedImageSessionRefs(): ReadonlyMap<string, ReadonlySet<string>> {
    return extractedImageSessionRefs;
}

/** @internal for tests only */
export function _testGetAttachments(): ReadonlyMap<string, StoredAttachment> {
    return attachments;
}

function addSessionRef(attachmentId: string, sessionId: string): void {
    let refs = extractedImageSessionRefs.get(attachmentId);
    if (!refs) {
        refs = new Set();
        extractedImageSessionRefs.set(attachmentId, refs);
    }
    refs.add(sessionId);
}

/** Check whether ANY session referencing this attachment is durable. */
function hasAnyDurableSessionRef(
    attachmentId: string,
    fallbackSessionId: string,
    durableSessionIds: Set<string>,
): boolean {
    const refs = extractedImageSessionRefs.get(attachmentId);
    if (refs) {
        for (const sid of refs) {
            if (durableSessionIds.has(sid)) return true;
        }
    }
    // Also check the record's own sessionId as a fallback
    return durableSessionIds.has(fallbackSessionId);
}

// ── SQLite persistence for extracted images ──────────────────────────────────
// Extracted image metadata is persisted to SQLite so it survives server restarts.
// The in-memory Map remains the hot path; SQLite is written on store and read on boot.

export async function ensureExtractedAttachmentTable(): Promise<void> {
    await getKysely().schema
        .createTable("attachment")
        .ifNotExists()
        .addColumn("attachmentId", "text", (col) => col.primaryKey())
        .addColumn("sessionId", "text", (col) => col.notNull())
        .addColumn("ownerUserId", "text", (col) => col.notNull())
        .addColumn("uploaderUserId", "text", (col) => col.notNull())
        .addColumn("filename", "text", (col) => col.notNull())
        .addColumn("mimeType", "text", (col) => col.notNull())
        .addColumn("size", "integer", (col) => col.notNull())
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("expiresAt", "text", (col) => col.notNull())
        .addColumn("filePath", "text", (col) => col.notNull())
        .execute();

    await getKysely().schema
        .createTable("extracted_attachment")
        .ifNotExists()
        .addColumn("attachmentId", "text", (col) => col.primaryKey())
        .addColumn("sessionId", "text", (col) => col.notNull())
        .addColumn("ownerUserId", "text", (col) => col.notNull())
        .addColumn("filename", "text", (col) => col.notNull())
        .addColumn("mimeType", "text", (col) => col.notNull())
        .addColumn("size", "integer", (col) => col.notNull())
        .addColumn("createdAt", "text", (col) => col.notNull())
        .addColumn("expiresAt", "text", (col) => col.notNull())
        .addColumn("filePath", "text", (col) => col.notNull())
        .execute();

    // Junction table: tracks ALL sessions that reference each extracted attachment.
    // This prevents data loss when the same user produces identical images across
    // multiple sessions — sweep/rehydration checks the full set of references
    // rather than a single sessionId.
    await getKysely().schema
        .createTable("extracted_attachment_session")
        .ifNotExists()
        .addColumn("attachmentId", "text", (col) => col.notNull())
        .addColumn("sessionId", "text", (col) => col.notNull())
        .execute();

    // Create a unique index to prevent duplicate (attachmentId, sessionId) pairs
    await getKysely().schema
        .createIndex("idx_eas_unique")
        .ifNotExists()
        .on("extracted_attachment_session")
        .columns(["attachmentId", "sessionId"])
        .unique()
        .execute();
}

/** Persist a session reference for an extracted attachment. */
async function persistSessionRef(attachmentId: string, sessionId: string): Promise<void> {
    await getKysely()
        .insertInto("extracted_attachment_session" as any)
        .values({ attachmentId, sessionId })
        .onConflict((oc) => oc.columns(["attachmentId", "sessionId"]).doNothing())
        .execute();
}

/** Batch-load all session refs for a set of attachment IDs in a single query. */
async function batchLoadSessionRefsFromDb(attachmentIds: string[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    if (attachmentIds.length === 0) return result;
    const rows = await getKysely()
        .selectFrom("extracted_attachment_session" as any)
        .select(["attachmentId", "sessionId"])
        .where("attachmentId", "in", attachmentIds)
        .execute();
    for (const row of rows as Array<{ attachmentId: string; sessionId: string }>) {
        let refs = result.get(row.attachmentId);
        if (!refs) {
            refs = new Set();
            result.set(row.attachmentId, refs);
        }
        refs.add(row.sessionId);
    }
    return result;
}

/** Remove all session references for an attachment from SQLite. */
async function removePersistedSessionRefs(attachmentId: string): Promise<void> {
    await getKysely()
        .deleteFrom("extracted_attachment_session" as any)
        .where("attachmentId", "=", attachmentId)
        .execute();
}

/** Persist an extracted attachment record to SQLite (upsert). */
async function persistUploadedAttachment(record: StoredAttachment): Promise<void> {
    await getKysely()
        .insertInto("attachment" as any)
        .values({
            attachmentId: record.attachmentId,
            sessionId: record.sessionId,
            ownerUserId: record.ownerUserId,
            uploaderUserId: record.uploaderUserId,
            filename: record.filename,
            mimeType: record.mimeType,
            size: record.size,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            filePath: record.filePath,
        })
        .onConflict((oc) => oc.column("attachmentId").doUpdateSet({ expiresAt: record.expiresAt }))
        .execute();
}

async function removePersistedUploadedAttachment(attachmentId: string): Promise<void> {
    await getKysely()
        .deleteFrom("attachment" as any)
        .where("attachmentId", "=", attachmentId)
        .execute();
}

async function persistExtractedAttachment(record: StoredAttachment): Promise<void> {
    await getKysely()
        .insertInto("extracted_attachment")
        .values({
            attachmentId: record.attachmentId,
            sessionId: record.sessionId,
            ownerUserId: record.ownerUserId,
            filename: record.filename,
            mimeType: record.mimeType,
            size: record.size,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            filePath: record.filePath,
        })
        .onConflict((oc) =>
            oc.column("attachmentId").doUpdateSet({
                expiresAt: record.expiresAt,
                sessionId: record.sessionId,
            }),
        )
        .execute();
}

/** Remove an extracted attachment record from SQLite. */
async function removePersistedAttachment(attachmentId: string): Promise<void> {
    await getKysely()
        .deleteFrom("extracted_attachment")
        .where("attachmentId", "=", attachmentId)
        .execute();
}

/**
 * Rehydrate the in-memory attachment registry from SQLite on server startup.
 * Only loads non-expired records whose files still exist on disk.
 */
export async function rehydrateAttachments(): Promise<number> {
    const rows = await getKysely().selectFrom("attachment" as any).selectAll().execute();
    let loaded = 0;
    for (const row of rows as Array<Record<string, string | number>>) {
        const expiresAtMs = Date.parse(String(row.expiresAt));
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
            try { await rm(String(row.filePath), { force: true }); } catch {}
            await removePersistedUploadedAttachment(String(row.attachmentId));
            continue;
        }
        try {
            await access(String(row.filePath));
        } catch {
            await removePersistedUploadedAttachment(String(row.attachmentId));
            continue;
        }
        attachments.set(String(row.attachmentId), {
            attachmentId: String(row.attachmentId),
            sessionId: String(row.sessionId),
            ownerUserId: String(row.ownerUserId),
            uploaderUserId: String(row.uploaderUserId),
            filename: String(row.filename),
            mimeType: String(row.mimeType),
            size: Number(row.size),
            createdAt: String(row.createdAt),
            expiresAt: String(row.expiresAt),
            expiresAtMs,
            filePath: String(row.filePath),
        });
        loaded++;
    }
    return loaded;
}

export async function rehydrateExtractedAttachments(): Promise<number> {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // Handle expired rows: renew those belonging to durable sessions, delete the rest.
    const durableSessionIds = await getDurableSessionIds();
    const expiredRows = await getKysely()
        .selectFrom("extracted_attachment")
        .selectAll()
        .where("expiresAt", "<=", nowIso)
        .execute();

    // Batch-load all session refs for expired rows in one query.
    const expiredRefMap = await batchLoadSessionRefsFromDb(expiredRows.map((r) => r.attachmentId));

    const toDelete: string[] = [];
    for (const row of expiredRows) {
        // Check all session refs (from junction table) and the row's own sessionId
        const rowSessionRefs = expiredRefMap.get(row.attachmentId) ?? new Set<string>();
        const allRefs = new Set([row.sessionId, ...rowSessionRefs]);
        if ([...allRefs].some((sid) => durableSessionIds.has(sid))) {
            // Renew TTL for attachments belonging to durable sessions
            const refreshed = new Date(nowMs + EXTRACTED_IMAGE_TTL_MS).toISOString();
            await getKysely()
                .updateTable("extracted_attachment")
                .set({ expiresAt: refreshed })
                .where("attachmentId", "=", row.attachmentId)
                .execute();
        } else {
            try { await rm(row.filePath, { force: true }); } catch {}
            toDelete.push(row.attachmentId);
        }
    }
    if (toDelete.length > 0) {
        await getKysely()
            .deleteFrom("extracted_attachment")
            .where("attachmentId", "in", toDelete)
            .execute();
        // Also clean up session ref junction table entries
        await getKysely()
            .deleteFrom("extracted_attachment_session" as any)
            .where("attachmentId", "in", toDelete)
            .execute();
    }

    const rows = await getKysely()
        .selectFrom("extracted_attachment")
        .selectAll()
        .execute();

    // Batch-load all session refs for active rows in one query.
    const activeRefMap = await batchLoadSessionRefsFromDb(rows.map((r) => r.attachmentId));

    let loaded = 0;
    for (const row of rows) {
        // Skip if file is missing from disk
        try {
            await access(row.filePath);
        } catch {
            await removePersistedAttachment(row.attachmentId);
            await removePersistedSessionRefs(row.attachmentId);
            continue;
        }

        // Skip if already in memory (shouldn't happen on cold start, but be safe)
        if (attachments.has(row.attachmentId)) continue;

        const expiresAtMs = Date.parse(row.expiresAt);
        attachments.set(row.attachmentId, {
            attachmentId: row.attachmentId,
            sessionId: row.sessionId,
            ownerUserId: row.ownerUserId,
            uploaderUserId: "system",
            filename: row.filename,
            mimeType: row.mimeType,
            size: row.size as number,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            expiresAtMs,
            filePath: row.filePath,
        });

        // Rehydrate session refs from junction table
        const refSet = activeRefMap.get(row.attachmentId) ?? new Set<string>();
        refSet.add(row.sessionId); // Ensure the main sessionId is always included
        extractedImageSessionRefs.set(row.attachmentId, refSet);

        loaded++;
    }

    return loaded;
}
