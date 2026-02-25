import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

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
    filePath: string;
}

const DEFAULT_ATTACHMENT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

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

export function sanitizeFilename(filename: string): string {
    return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
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
        filename: file.name || safeName,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        filePath: targetPath,
    };

    attachments.set(attachmentId, record);
    return record;
}

export function getStoredAttachment(attachmentId: string): StoredAttachment | null {
    const record = attachments.get(attachmentId);
    if (!record) return null;

    if (Date.parse(record.expiresAt) <= Date.now()) {
        void deleteStoredAttachment(attachmentId);
        return null;
    }

    return record;
}

export async function deleteStoredAttachment(attachmentId: string): Promise<void> {
    const record = attachments.get(attachmentId);
    if (!record) return;
    attachments.delete(attachmentId);
    try {
        await rm(record.filePath, { force: true });
    } catch {}
}

export async function sweepExpiredAttachments(nowMs: number = Date.now()): Promise<void> {
    const removals: Promise<void>[] = [];
    for (const [attachmentId, record] of attachments.entries()) {
        const expiresAtMs = Date.parse(record.expiresAt);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) continue;
        removals.push(deleteStoredAttachment(attachmentId));
    }
    await Promise.all(removals);
}
