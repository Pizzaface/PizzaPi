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
import { storeExtractedImage, getExtractedImageUrl } from "../attachments/store.js";

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
    /** Images that were extracted and need to be stored */
    extracted: ExtractedImage[];
    /** Total bytes of base64 data that was removed */
    savedBytes: number;
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
    // Strip data URI prefix if present
    const b64 = data.includes(",") ? data.split(",").pop() ?? "" : data;
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
export function extractImages(messages: unknown[], sessionId: string, userId: string = "unknown"): ExtractionResult {
    const extracted: ExtractedImage[] = [];
    let savedBytes = 0;

    const processedMessages = messages.map((msg) => processMessage(msg, sessionId, userId, extracted, (bytes) => { savedBytes += bytes; }));

    return { messages: processedMessages, extracted, savedBytes };
}

function processMessage(
    msg: unknown,
    sessionId: string,
    userId: string,
    extracted: ExtractedImage[],
    addSaved: (bytes: number) => void,
): unknown {
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
        const attachmentId = contentHash(data, userId);
        extracted.push({ attachmentId, mimeType, base64Data: data, sizeBytes });
        addSaved(data.length); // Save the base64 string length (chars ≈ bytes for ASCII)

        changed = true;

        // Build replacement block — preserve all fields except inline data
        const newSource: Record<string, unknown> = {
            ...(source ?? {}),
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

    if (!Array.isArray(s.messages) || s.messages.length === 0) return state;

    const result = extractImages(s.messages, sessionId, userId);
    if (result.extracted.length === 0) return state;

    // Store all extracted images as attachments (fire concurrently)
    await Promise.all(
        result.extracted.map((img) =>
            storeExtractedImage({
                attachmentId: img.attachmentId,
                sessionId,
                ownerUserId: userId,
                mimeType: img.mimeType,
                base64Data: img.base64Data,
            }),
        ),
    );

    console.log(
        `[strip-images] Extracted ${result.extracted.length} image(s) from session ${sessionId}, ` +
        `saved ~${(result.savedBytes / 1024 / 1024).toFixed(1)} MB from state payload`,
    );

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

    if (evt.type !== "agent_end" || !Array.isArray(evt.messages)) return event;

    const result = extractImages(evt.messages, sessionId, userId);
    if (result.extracted.length === 0) return event;

    await Promise.all(
        result.extracted.map((img) =>
            storeExtractedImage({
                attachmentId: img.attachmentId,
                sessionId,
                ownerUserId: userId,
                mimeType: img.mimeType,
                base64Data: img.base64Data,
            }),
        ),
    );

    console.log(
        `[strip-images] Extracted ${result.extracted.length} image(s) from agent_end for session ${sessionId}, ` +
        `saved ~${(result.savedBytes / 1024 / 1024).toFixed(1)} MB`,
    );

    return { ...evt, messages: result.messages };
}
