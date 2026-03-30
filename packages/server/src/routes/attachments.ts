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

/**
 * Strip ASCII control characters (0x00–0x1F and 0x7F) from a string.
 *
 * HTTP header values must not contain raw control characters — Bun throws
 * when constructing a Response with such a header.  This is the first-line
 * defence; per-header encoding (RFC 5987, percent-encoding) provides a
 * second layer.
 */
export function sanitizeControlChars(value: string): string {
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\x00-\x1F\x7F]/g, "_");
}

/**
 * Percent-encode a filename per RFC 5987.
 *
 * `encodeURIComponent` leaves `'`, `(`, `)`, `*`, and `!` unencoded, but
 * RFC 5987 uses `'` as a delimiter (`charset'language'value`) so those
 * characters must be encoded manually to avoid mis-parsing.
 */
export function rfc5987Encode(value: string): string {
    return encodeURIComponent(value)
        .replace(/'/g, "%27")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")
        .replace(/\*/g, "%2A");
}

/**
 * Build a Content-Disposition header value safe for Bun's header validation.
 *
 * Bun rejects header values with non-ASCII characters (e.g. macOS screenshot
 * filenames that contain U+202F NARROW NO-BREAK SPACE before "AM"/"PM").
 * We produce both an ASCII-safe `filename` and an RFC 5987 `filename*` with
 * the full UTF-8 name percent-encoded.
 */
export function buildContentDisposition(rawFilename: string, mode: "inline" | "attachment" = "inline"): string {
    const sanitized = sanitizeControlChars(rawFilename);
    const asciiFallback = sanitized.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const encodedName = rfc5987Encode(sanitized);
    return `${mode}; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`;
}

/**
 * Percent-encode a filename for use in an HTTP header value.
 *
 * Uses full percent-encoding so the original Unicode filename can be
 * recovered by the consumer (the runner decodes it). This preserves
 * filenames like `résumé.txt` or `截图.png` across the wire.
 */
export function encodeHeaderFilename(value: string): string {
    return rfc5987Encode(sanitizeControlChars(value));
}

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

        if (!session.userId || session.userId !== identity.userId) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
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

        // Support both header-based and query-parameter API key auth for
        // backward compatibility.  Clients that embed the key in the URL
        // (e.g. direct download links, documented ?apiKey= pattern) must
        // continue to work alongside the preferred x-api-key header form.
        const headerApiKey = req.headers.get("x-api-key") || undefined;
        const queryApiKey = url.searchParams.get("apiKey") || undefined;
        const providedApiKey = headerApiKey ?? queryApiKey;
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

        // SVGs can carry embedded scripts and execute them when rendered inline by
        // the browser (e.g. inside an <img> or directly navigated to).  Force the
        // browser to download SVG files rather than render them by overriding the
        // MIME type to a non-renderable type and using attachment disposition.
        const isSvg = attachment.mimeType === "image/svg+xml";
        const servedMimeType = isSvg ? "application/octet-stream" : attachment.mimeType;
        const dispositionMode = isSvg ? "attachment" : "inline";

        return new Response(Bun.file(attachment.filePath), {
            headers: {
                "content-type": servedMimeType,
                "content-length": String(attachment.size),
                "content-disposition": buildContentDisposition(attachment.filename, dispositionMode),
                "x-attachment-id": attachment.attachmentId,
                "x-attachment-filename": encodeHeaderFilename(attachment.filename),
            },
        });
    }

    return undefined;
};
