/**
 * Input and attachment handling for messages from the web UI.
 *
 * Pure/async functions with no relay state dependency — httpBaseUrl and apiKey
 * are passed as parameters.
 */

import type { RemoteInputAttachment } from "./remote-types.js";
import { saveSessionAttachment } from "./session-attachments.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("remote-input");

/** MIME types and file extensions recognized as text-based (safe to decode as UTF-8). */
const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_TYPES = new Set([
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/javascript",
    "application/typescript",
    "application/x-sh",
    "application/x-shellscript",
    "application/sql",
    "application/graphql",
    "application/toml",
    "application/x-toml",
    "application/xhtml+xml",
    "application/ld+json",
]);
const TEXT_FILE_EXTENSIONS = new Set([
    ".txt", ".md", ".markdown", ".json", ".jsonl", ".yaml", ".yml",
    ".xml", ".csv", ".tsv", ".log", ".ini", ".cfg", ".conf", ".toml",
    ".env", ".sh", ".bash", ".zsh", ".fish",
    ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx",
    ".py", ".rb", ".rs", ".go", ".java", ".kt", ".kts", ".scala",
    ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".swift", ".m",
    ".html", ".htm", ".css", ".scss", ".sass", ".less",
    ".sql", ".graphql", ".gql",
    ".r", ".R", ".lua", ".pl", ".pm", ".ex", ".exs", ".erl",
    ".hs", ".ml", ".mli", ".clj", ".cljs", ".elm", ".dart",
    ".vue", ".svelte", ".astro",
    ".dockerfile", ".dockerignore", ".gitignore", ".editorconfig",
    ".lock", ".prisma", ".proto", ".tf", ".hcl",
]);

/** Returns true if the MIME type or filename indicates text content. */
export function isTextMimeType(mimeType: string, filename?: string): boolean {
    const lower = mimeType.toLowerCase();
    if (TEXT_MIME_PREFIXES.some((p) => lower.startsWith(p))) return true;
    if (TEXT_MIME_TYPES.has(lower)) return true;

    // Fall back to file extension when MIME is generic (e.g. application/octet-stream)
    if (filename) {
        const dotIdx = filename.lastIndexOf(".");
        if (dotIdx >= 0) {
            const ext = filename.slice(dotIdx).toLowerCase();
            if (TEXT_FILE_EXTENSIONS.has(ext)) return true;
        }
    }
    return false;
}

export function normalizeRemoteInputAttachments(raw: unknown): RemoteInputAttachment[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((item) => item && typeof item === "object")
        .map((item) => {
            const record = item as Record<string, unknown>;
            return {
                attachmentId: typeof record.attachmentId === "string" ? record.attachmentId : undefined,
                mediaType: typeof record.mediaType === "string" ? record.mediaType : undefined,
                filename: typeof record.filename === "string" ? record.filename : undefined,
                url: typeof record.url === "string" ? record.url : undefined,
            } satisfies RemoteInputAttachment;
        })
        .filter((item) =>
            (typeof item.attachmentId === "string" && item.attachmentId.length > 0) ||
            (typeof item.url === "string" && item.url.length > 0),
        );
}

export function parseDataUrl(url: string): { mediaType: string; data: string } | null {
    const match = /^data:([^;,]+)?;base64,(.+)$/i.exec(url);
    if (!match) return null;
    return {
        mediaType: match[1] || "application/octet-stream",
        data: match[2],
    };
}

export async function loadAttachmentFromRelay(
    attachmentId: string,
    httpBaseUrl: string,
    apiKey: string,
): Promise<{ mediaType: string; filename?: string; dataBase64: string } | null> {
    const url = `${httpBaseUrl}/api/attachments/${encodeURIComponent(attachmentId)}`;
    let response: Response;
    try {
        response = await fetch(url, {
            headers: { "x-api-key": apiKey },
        });
    } catch (err) {
        log.error(`attachment fetch failed (network error): ${url} — ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        log.error(`pizzapi: attachment fetch failed: ${response.status} ${response.statusText} — ${url}${body ? ` — ${body}` : ""}`);
        return null;
    }

    const mediaType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
    const rawFilename = response.headers.get("x-attachment-filename") ?? undefined;
    // The server percent-encodes this header to survive Bun's ASCII-only
    // header validation. Decode it to recover the original Unicode filename.
    let filename: string | undefined;
    if (rawFilename) {
        try {
            filename = decodeURIComponent(rawFilename);
        } catch {
            // Malformed percent-encoding — use the raw value as-is
            filename = rawFilename;
        }
    }
    const dataBase64 = Buffer.from(await response.arrayBuffer()).toString("base64");

    return { mediaType, filename, dataBase64 };
}

export async function buildUserMessageFromRemoteInput(
    text: string,
    attachments: RemoteInputAttachment[],
    httpBaseUrl: string,
    apiKey: string,
    /** When provided, attachments are persisted to ~/.pizzapi/session-attachments/{sessionId}/ */
    sessionId?: string,
): Promise<string | unknown[]> {
    if (attachments.length === 0) return text;

    const parts: unknown[] = [];
    if (text.length > 0) {
        parts.push({ type: "text", text });
    }

    for (const attachment of attachments) {
        let mediaType = attachment.mediaType || "application/octet-stream";
        let filename = attachment.filename;
        let dataBase64: string | null = null;

        if (attachment.attachmentId) {
            const loaded = await loadAttachmentFromRelay(attachment.attachmentId, httpBaseUrl, apiKey);
            if (loaded) {
                mediaType = loaded.mediaType;
                filename = loaded.filename ?? filename;
                dataBase64 = loaded.dataBase64;
            }
        } else if (attachment.url) {
            const parsed = parseDataUrl(attachment.url);
            if (parsed) {
                mediaType = parsed.mediaType;
                dataBase64 = parsed.data;
            }
        }

        // Persist attachment to session-scoped storage.
        // Awaited (not fire-and-forget) to prevent same-name overwrite races:
        // saveSessionAttachment deduplicates names by reading the directory,
        // which is non-atomic; serializing saves prevents two files with the
        // same sanitized name from clobbering each other.
        let savedPath: string | null = null;
        if (dataBase64 && sessionId) {
            const attachFilename = filename || `attachment-${Date.now()}`;
            const buf = Buffer.from(dataBase64, "base64");
            try {
                const saved = await saveSessionAttachment(sessionId, attachFilename, mediaType, buf);
                savedPath = saved.filePath;
            } catch (err) {
                log.error(`pizzapi: failed to persist attachment: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        if (dataBase64 && mediaType.startsWith("image/")) {
            parts.push({
                type: "image",
                mimeType: mediaType,
                data: dataBase64,
            });
            continue;
        }

        const label = filename || mediaType || "attachment";

        if (isTextMimeType(mediaType, filename)) {
            if (savedPath) {
                // File is saved on the runner — reference by path instead of inlining.
                parts.push({ type: "text", text: `[Attached file saved to runner: ${savedPath}]` });
            } else if (dataBase64) {
                // No session storage available — fall back to inlining.
                const decoded = Buffer.from(dataBase64, "base64").toString("utf-8");
                parts.push({ type: "text", text: `--- ${label} ---\n${decoded}\n--- end ${label} ---` });
            } else {
                // Attachment bytes unavailable (relay fetch failed or data URL invalid) — keep a
                // visible placeholder so the agent/user knows the file was sent but not decoded.
                parts.push({ type: "text", text: `[Attached file: ${label} — content unavailable]` });
            }
            continue;
        }

        parts.push({ type: "text", text: `[Attachment provided by web client: ${label} — binary content not included]` });
    }

    return parts.length > 0 ? parts : text;
}
