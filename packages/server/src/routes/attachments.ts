/**
 * Attachments router — file upload and download for sessions.
 */

import { requireSession, validateApiKey } from "../middleware.js";
import { getSharedSession } from "../ws/sio-registry.js";
import {
    attachmentMaxFileSizeBytes,
    getStoredAttachment,
    storeSessionAttachment,
} from "../attachments/store.js";
import type { RouteHandler } from "./types.js";

export const handleAttachmentsRoute: RouteHandler = async (req, url) => {
    // ── Upload: POST /api/sessions/:id/attachments ─────────────────────
    if (
        url.pathname.startsWith("/api/sessions/") &&
        url.pathname.endsWith("/attachments") &&
        req.method === "POST"
    ) {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const sessionId = decodeURIComponent(
            url.pathname.slice("/api/sessions/".length, -"/attachments".length),
        );

        if (!sessionId) {
            return Response.json({ error: "Missing session ID" }, { status: 400 });
        }

        const session = await getSharedSession(sessionId);
        if (!session) {
            return Response.json({ error: "Session is not live" }, { status: 404 });
        }

        const formData = await req.formData();
        const maxBytes = attachmentMaxFileSizeBytes();

        const fileValues = [...formData.getAll("files"), ...formData.getAll("file")];
        const files = fileValues.filter((value): value is File => value instanceof File);

        if (files.length === 0) {
            return Response.json({ error: "No files uploaded" }, { status: 400 });
        }

        for (const file of files) {
            if (file.size > maxBytes) {
                return Response.json(
                    { error: `File too large: ${file.name} exceeds ${maxBytes} bytes` },
                    { status: 413 },
                );
            }
        }

        const ownerUserId = session.userId ?? identity.userId;

        const attachments = await Promise.all(
            files.map((file) =>
                storeSessionAttachment({
                    sessionId,
                    ownerUserId,
                    uploaderUserId: identity.userId,
                    file,
                }),
            ),
        );

        return Response.json({
            attachments: attachments.map((a) => ({
                attachmentId: a.attachmentId,
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.size,
                expiresAt: a.expiresAt,
            })),
        });
    }

    // ── Download: GET /api/attachments/:id ──────────────────────────────
    if (url.pathname.startsWith("/api/attachments/") && req.method === "GET") {
        const attachmentId = decodeURIComponent(url.pathname.slice("/api/attachments/".length));
        if (!attachmentId) {
            return Response.json({ error: "Missing attachment ID" }, { status: 400 });
        }

        const providedApiKey =
            req.headers.get("x-api-key") ?? url.searchParams.get("apiKey") ?? undefined;
        const identity = providedApiKey
            ? await validateApiKey(req, providedApiKey)
            : await requireSession(req);
        if (identity instanceof Response) return identity;

        const attachment = await getStoredAttachment(attachmentId);
        if (!attachment) {
            return Response.json({ error: "Attachment not found" }, { status: 404 });
        }

        if (attachment.ownerUserId !== identity.userId) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        return new Response(Bun.file(attachment.filePath), {
            headers: {
                "content-type": attachment.mimeType,
                "content-length": String(attachment.size),
                "content-disposition": `inline; filename="${attachment.filename.replace(/\"/g, "")}"`,
                "x-attachment-id": attachment.attachmentId,
                "x-attachment-filename": attachment.filename,
            },
        });
    }

    return undefined;
};
