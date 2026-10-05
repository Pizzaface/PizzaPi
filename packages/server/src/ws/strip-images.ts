// ============================================================================
// strip-images.ts — Extract inline base64 images from session state
//
// Walks the messages array in session_active / agent_end payloads and
// replaces inline base64 image data with attachment URLs. This prevents
// multi-megabyte payloads from saturating Socket.IO buffers, Redis memory,
// and viewer bandwidth.
//
// Pure transformation logic lives in extractImages() (testable, no side
// effects). The async storeAndReplace() function handles disk I/O.
// ============================================================================

import { createHash } from "node:crypto";
import {
    storeExtractedImage,
    getExtractedImageUrl,
    attachmentMaxFileSizeBytes,
    ExtractedImageRejectedError,
} from "../attachments/store.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("strip-images");

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExtractedImage {
    /** Generated attachment ID */
    attachmentId: string;
    /** MIME type of the image */
    mimeType: string;
    /** Raw base64 data (without data URI prefix) */
    base64Data: string;
    /** Byte size of the decoded image */
    sizeBytes: number;
}

export interface ExtractionResult {
    /** The messages array with base64 data replaced by URL references */
    messages: unknown[];
    /** Unique images that were extracted and need to be stored */
    extracted: ExtractedImage[];
    /** Total bytes of base64 data that was removed */
    savedBytes: number;
    /** Images dropped (not stored, data removed) because they exceeded a limit */
    omitted: number;
}

export type OmittedImageReason =
    | "too_large"
    | "too_many_images"
    | "event_budget_exceeded"
    | "quota_exceeded"
    | "invalid";

/**
 * Result of storing one event's extracted images. Only deliberate policy
 * rejections (size/quota/invalid) may discard content; unexpected storage
 * failures keep the original inline image so nothing is irreversibly erased.
 */
export interface StoreExtractedImagesResult {
    /** Images refused by policy: replaced with omitted markers. */
    rejected: Map<string, OmittedImageReason>;
    /** Images that hit an unexpected storage error: inline data is kept. */
    failed: Set<string>;
}

export interface ImageExtractionLimits {
    /** Max decoded bytes of a single image (the attachment upload limit). */
    maxImageBytes: number;
    /** Max unique images extracted from one event. */
    maxImagesPerEvent: number;
    /** Max aggregate decoded bytes of unique images extracted from one event. */
    maxEventBytes: number;
}

export const DEFAULT_RELAY_IMAGE_MAX_PER_EVENT = 500;
export const DEFAULT_RELAY_IMAGE_MAX_EVENT_BYTES = 128 * 1024 * 1024;
/** Images written to disk concurrently per event. */
const STORE_CONCURRENCY = 4;

function positiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function getImageExtractionLimits(): ImageExtractionLimits {
    return {
        maxImageBytes: attachmentMaxFileSizeBytes(),
        maxImagesPerEvent: positiveIntEnv("PIZZAPI_RELAY_IMAGE_MAX_PER_EVENT", DEFAULT_RELAY_IMAGE_MAX_PER_EVENT),
        maxEventBytes: positiveIntEnv("PIZZAPI_RELAY_IMAGE_MAX_EVENT_BYTES", DEFAULT_RELAY_IMAGE_MAX_EVENT_BYTES),
    };
}

// ── Minimum size threshold ───────────────────────────────────────────────────
// Don't bother extracting tiny images (icons, avatars) — the overhead of a
// separate HTTP request isn't worth it. Only extract images > 10 KB.
const MIN_EXTRACT_SIZE_BYTES = 10 * 1024;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip the `data:...;base64,` prefix from a data URI string.
 * Returns the raw base64 portion. If there's no prefix, returns the input unchanged.
 */
export function stripDataUriPrefix(data: string): string {
    const commaIdx = data.indexOf(",");
    if (commaIdx === -1) return data;
    // Quick sanity check — a data URI starts with "data:"
    const head = data.slice(0, commaIdx);
    if (head.startsWith("data:") && head.includes(";base64")) {
        return data.slice(commaIdx + 1);
    }
    return data;
}

/**
 * Produce a deterministic attachment ID from the base64 content and userId
 * so that the same image in repeated state updates maps to the same stored
 * file, but different users get separate attachment records (attachment
 * downloads enforce ownerUserId matching).
 */
function contentHash(data: string, userId: string): string {
    // Strip data URI prefix (if present) so identical images produce the same ID
    // regardless of whether they arrive as raw base64 or data:...;base64,...
    const normalized = stripDataUriPrefix(data);
    return createHash("sha256").update(userId).update(":").update(normalized).digest("hex").slice(0, 24);
}

// ── Pure extraction logic ────────────────────────────────────────────────────

/**
 * Estimate decoded byte size of a base64 string (with or without data URI prefix).
 */
export function estimateBase64Bytes(data: string): number {
    // Strip data URI prefix if present (lastIndexOf avoids splitting a
    // potentially huge attacker-controlled string into an array).
    const b64 = data.slice(data.lastIndexOf(",") + 1);
    if (!b64) return 0;
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * Walk a messages array and extract inline base64 image data.
 *
 * Returns a new messages array with image data replaced by URL placeholders,
 * plus a list of extracted images that need to be persisted.
 *
 * This is a pure function — no I/O. Call storeAndReplaceImages() for the
 * full async pipeline.
 */
export function extractImages(
    messages: unknown[],
    sessionId: string,
    userId: string = "unknown",
    limits: ImageExtractionLimits = getImageExtractionLimits(),
): ExtractionResult {
    const ctx: ExtractionContext = {
        userId,
        limits,
        extracted: [],
        seen: new Set(),
        eventBytes: 0,
        savedBytes: 0,
        omitted: 0,
    };

    const processedMessages = messages.map((msg) => processMessage(msg, ctx));

    return { messages: processedMessages, extracted: ctx.extracted, savedBytes: ctx.savedBytes, omitted: ctx.omitted };
}

interface ExtractionContext {
    userId: string;
    limits: ImageExtractionLimits;
    extracted: ExtractedImage[];
    /** Attachment IDs already queued for this event (dedupe within event). */
    seen: Set<string>;
    eventBytes: number;
    savedBytes: number;
    omitted: number;
}

/**
 * Replace an image block's inline data with a marker explaining why it was
 * not kept. The block keeps its non-data fields and is never re-extracted.
 */
function omittedImageBlock(b: Record<string, unknown>, reason: OmittedImageReason, sizeBytes: number): Record<string, unknown> {
    const source = (b.source && typeof b.source === "object" ? b.source : {}) as Record<string, unknown>;
    const newSource: Record<string, unknown> = {
        ...source,
        type: "omitted",
        omitted: true,
        omittedReason: reason,
        originalSizeBytes: sizeBytes,
    };
    delete newSource.data;
    delete newSource.url;
    delete newSource.extracted;
    const newBlock: Record<string, unknown> = { ...b, source: newSource };
    delete newBlock.data;
    return newBlock;
}

function processMessage(msg: unknown, ctx: ExtractionContext): unknown {
    if (!msg || typeof msg !== "object") return msg;
    const m = msg as Record<string, unknown>;

    // Only process messages that have a content array
    if (!Array.isArray(m.content)) return msg;

    let changed = false;
    const newContent = m.content.map((block: unknown) => {
        if (!block || typeof block !== "object") return block;
        const b = block as Record<string, unknown>;

        if (b.type !== "image") return block;

        // Already extracted — skip
        const source = b.source as Record<string, unknown> | undefined;
        if (source?.extracted === true) return block;

        // Find the base64 data — could be in b.data or source.data
        const data = typeof b.data === "string" ? b.data : typeof source?.data === "string" ? source.data : null;
        if (!data) return block;

        const sizeBytes = estimateBase64Bytes(data);
        if (sizeBytes < MIN_EXTRACT_SIZE_BYTES) return block;

        // Enforce limits on the encoded length, before hashing or decoding.
        if (sizeBytes > ctx.limits.maxImageBytes) {
            ctx.omitted++;
            ctx.savedBytes += data.length;
            changed = true;
            return omittedImageBlock(b, "too_large", sizeBytes);
        }

        // Determine MIME type
        const mimeType = typeof b.mimeType === "string"
            ? b.mimeType
            : typeof source?.media_type === "string"
                ? source.media_type
                : typeof source?.mediaType === "string"
                    ? source.mediaType
                    : "image/png";

        // Use a content-based hash (scoped to userId) as the attachment ID
        // so repeated state updates with the same image don't create duplicate
        // files, but different users get separate records (attachment downloads
        // enforce ownerUserId matching).
        const attachmentId = contentHash(data, ctx.userId);
        if (!ctx.seen.has(attachmentId)) {
            if (ctx.extracted.length >= ctx.limits.maxImagesPerEvent) {
                ctx.omitted++;
                ctx.savedBytes += data.length;
                changed = true;
                return omittedImageBlock(b, "too_many_images", sizeBytes);
            }
            if (ctx.eventBytes + sizeBytes > ctx.limits.maxEventBytes) {
                ctx.omitted++;
                ctx.savedBytes += data.length;
                changed = true;
                return omittedImageBlock(b, "event_budget_exceeded", sizeBytes);
            }
            ctx.seen.add(attachmentId);
            ctx.eventBytes += sizeBytes;
            ctx.extracted.push({ attachmentId, mimeType, base64Data: data, sizeBytes });
        }
        ctx.savedBytes += data.length; // Save the base64 string length (chars ≈ bytes for ASCII)

        changed = true;

        // Build replacement block — preserve all fields except inline data
        const newSource: Record<string, unknown> = {
            ...(source),
            type: "url",
            url: getExtractedImageUrl(attachmentId),
            extracted: true,
            originalSizeBytes: sizeBytes,
        };
        // Remove the inline data from source
        delete newSource.data;

        const newBlock: Record<string, unknown> = { ...b, source: newSource };
        // Remove top-level data if it was there
        delete newBlock.data;

        return newBlock;
    });

    if (!changed) return msg;
    return { ...m, content: newContent };
}

// ── Async store + replace pipeline ───────────────────────────────────────────

/**
 * Store extracted images with bounded concurrency. Policy rejections are
 * returned with their reason so their URL placeholders become omitted markers;
 * unexpected failures are returned separately so the caller can restore the
 * original inline data instead of leaving dangling attachment links.
 */
export async function storeExtractedImages(
    images: ExtractedImage[],
    sessionId: string,
    userId: string,
    concurrency: number = STORE_CONCURRENCY,
): Promise<StoreExtractedImagesResult> {
    const rejected = new Map<string, OmittedImageReason>();
    const failed = new Set<string>();
    let next = 0;
    const worker = async () => {
        while (next < images.length) {
            const img = images[next++];
            if (!img) break;
            try {
                await storeExtractedImage({
                    attachmentId: img.attachmentId,
                    sessionId,
                    ownerUserId: userId,
                    mimeType: img.mimeType,
                    base64Data: img.base64Data,
                });
            } catch (err) {
                if (err instanceof ExtractedImageRejectedError) {
                    rejected.set(img.attachmentId, err.reason);
                    log.warn(`Dropped extracted image for session ${sessionId}: ${err.message}`);
                } else {
                    failed.add(img.attachmentId);
                    log.error(`Failed to store extracted image for session ${sessionId}; keeping inline data:`, err);
                }
            }
        }
    };
    const workers = Math.max(1, Math.min(concurrency, images.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return { rejected, failed };
}

/**
 * Fix up URL placeholders for images that were not stored: policy rejections
 * become omitted markers; unexpected failures get the original inline block
 * back. `processed` is extractImages() output for `original`, which maps
 * messages and content blocks 1:1, so blocks are paired by position.
 */
function replaceUnstoredImages(
    original: unknown[],
    processed: unknown[],
    stored: StoreExtractedImagesResult,
): unknown[] {
    if (stored.rejected.size === 0 && stored.failed.size === 0) return processed;
    const urlToReason = new Map<string, OmittedImageReason>();
    for (const [id, reason] of stored.rejected) urlToReason.set(getExtractedImageUrl(id), reason);
    const failedUrls = new Set<string>();
    for (const id of stored.failed) failedUrls.add(getExtractedImageUrl(id));
    return processed.map((msg, msgIndex) => {
        if (!msg || typeof msg !== "object") return msg;
        const m = msg as Record<string, unknown>;
        if (!Array.isArray(m.content)) return msg;
        const originalContent = (original[msgIndex] as Record<string, unknown> | undefined)?.content;
        let changed = false;
        const content = m.content.map((block: unknown, blockIndex: number) => {
            if (!block || typeof block !== "object") return block;
            const b = block as Record<string, unknown>;
            const source = b.source as Record<string, unknown> | undefined;
            if (b.type !== "image" || source?.extracted !== true || typeof source.url !== "string") return block;
            if (failedUrls.has(source.url) && Array.isArray(originalContent) && originalContent[blockIndex] !== undefined) {
                changed = true;
                return originalContent[blockIndex];
            }
            const reason = urlToReason.get(source.url);
            if (!reason) return block;
            changed = true;
            const size = typeof source.originalSizeBytes === "number" ? source.originalSizeBytes : 0;
            return omittedImageBlock(b, reason, size);
        });
        return changed ? { ...m, content } : msg;
    });
}

/**
 * Extract, store (bounded), and rewrite one messages array. Returns null when
 * nothing changed so callers can return the original object untouched.
 * `complete` is false when an unexpected storage failure left inline image
 * data in place, so a later stage may retry extraction.
 */
async function extractAndStore(
    messages: unknown[],
    sessionId: string,
    userId: string,
    label: string,
): Promise<{ messages: unknown[]; complete: boolean } | null> {
    const result = extractImages(messages, sessionId, userId);
    if (result.extracted.length === 0 && result.omitted === 0) return null;

    const stored = await storeExtractedImages(result.extracted, sessionId, userId);
    const finalMessages = replaceUnstoredImages(messages, result.messages, stored);
    const omitted = result.omitted + stored.rejected.size;
    const extractedCount = result.extracted.length - stored.rejected.size - stored.failed.size;

    log.info(
        `${label}: extracted ${extractedCount} image(s) for session ${sessionId}` +
        (omitted > 0 ? `, omitted ${omitted} over-limit image(s)` : "") +
        (stored.failed.size > 0 ? `, kept ${stored.failed.size} image(s) inline after storage failure` : "") +
        `, saved ~${(result.savedBytes / 1024 / 1024).toFixed(1)} MB`,
    );
    return { messages: finalMessages, complete: stored.failed.size === 0 };
}

/**
 * Extract inline images from a session state object, store them as
 * attachments, and return the modified state with URL references.
 *
 * If state has no messages or no extractable images, returns the
 * original state unchanged (no copy).
 */
export async function storeAndReplaceImages(
    state: unknown,
    sessionId: string,
    userId: string,
): Promise<unknown> {
    if (!state || typeof state !== "object") return state;
    const s = state as Record<string, unknown>;

    // Fast exit if images were already stripped upstream (single-pass pipeline)
    if ((s as any)._imagesStripped === true) return state;

    if (!Array.isArray(s.messages) || s.messages.length === 0) return state;

    const result = await extractAndStore(s.messages, sessionId, userId, "state payload");
    if (!result) return state;

    return { ...s, messages: result.messages };
}

/**
 * Strip images from an agent_end event's messages array.
 * Similar to storeAndReplaceImages but operates on the event directly.
 */
export async function storeAndReplaceImagesInEvent(
    event: unknown,
    sessionId: string,
    userId: string,
): Promise<unknown> {
    if (!event || typeof event !== "object") return event;
    const evt = event as Record<string, unknown>;

    // Fast exit if images were already stripped upstream (single-pass pipeline)
    if ((evt as any)._imagesStripped === true) return event;

    if (evt.type !== "agent_end" || !Array.isArray(evt.messages)) return event;

    const result = await extractAndStore(evt.messages, sessionId, userId, "agent_end");
    if (!result) return event;

    return { ...evt, messages: result.messages };
}

// ── Pipeline-level image stripping ───────────────────────────────────────────

/**
 * Strip inline base64 images from any event type that carries a messages array.
 * Intended to be called ONCE at the top of the event ingestion pipeline so that
 * all downstream consumers (state storage, Redis cache, viewer broadcast) see
 * already-stripped payloads.
 *
 * Handles:
 *   - session_active  → event.state.messages
 *   - agent_end       → event.messages
 *   - session_messages_chunk → event.messages
 *
 * Sets `_imagesStripped: true` on the returned event so downstream calls to
 * storeAndReplaceImages / storeAndReplaceImagesInEvent can skip redundant work,
 * unless an unexpected storage failure kept inline image data: the flag is then
 * left unset so a downstream stage can retry extraction of just those images.
 */
export async function stripImagesFromPipelineEvent(
    event: unknown,
    sessionId: string,
    userId: string,
): Promise<unknown> {
    if (!event || typeof event !== "object") return event;
    const evt = event as Record<string, unknown>;

    // Already processed — nothing to do
    if (evt._imagesStripped === true) return event;

    const eventType = evt.type;

    if (eventType === "session_active") {
        const state = evt.state as Record<string, unknown> | undefined;
        if (!state || !Array.isArray(state.messages) || state.messages.length === 0) return event;

        const result = await extractAndStore(state.messages, sessionId, userId, "[pipeline] session_active");
        if (!result) return event;

        const out: Record<string, unknown> = { ...evt, state: { ...state, messages: result.messages } };
        if (result.complete) out._imagesStripped = true;
        return out;
    }

    if (eventType === "agent_end" || eventType === "session_messages_chunk") {
        if (!Array.isArray(evt.messages) || evt.messages.length === 0) return event;

        const result = await extractAndStore(evt.messages as unknown[], sessionId, userId, `[pipeline] ${String(eventType)}`);
        if (!result) return event;

        const out: Record<string, unknown> = { ...evt, messages: result.messages };
        if (result.complete) out._imagesStripped = true;
        return out;
    }

    return event;
}
