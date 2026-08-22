import { createHmac, timingSafeEqual } from "node:crypto";
import { getAuthContext } from "../auth.js";

/** Maximum lifetime for an attachment download token (5 minutes). */
export const ATTACHMENT_TOKEN_TTL_MS = 5 * 60 * 1000;

export interface AttachmentTokenPayload {
    v: 1;
    userId: string;
    attachmentId: string;
    exp: number;
}

function base64url(input: string): string {
    return Buffer.from(input, "utf8").toString("base64url");
}

function unbase64url(input: string): string | null {
    try {
        return Buffer.from(input, "base64url").toString("utf8");
    } catch {
        return null;
    }
}

function sign(encodedPayload: string): string {
    return createHmac("sha256", getAuthContext().config.secret).update(encodedPayload).digest("base64url");
}

export function createAttachmentToken(
    input: { userId: string; attachmentId: string },
    nowMs = Date.now(),
): { token: string; expiresAt: string } {
    const exp = Math.floor((nowMs + ATTACHMENT_TOKEN_TTL_MS) / 1000);
    const payload: AttachmentTokenPayload = { v: 1, userId: input.userId, attachmentId: input.attachmentId, exp };
    const encodedPayload = base64url(JSON.stringify(payload));
    const signature = sign(encodedPayload);
    return { token: `${encodedPayload}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyAttachmentToken(token: string, nowMs = Date.now()): AttachmentTokenPayload | null {
    const [encodedPayload, signature, extra] = token.split(".");
    if (!encodedPayload || !signature || extra !== undefined) return null;

    const expected = sign(encodedPayload);
    const actualBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) return null;

    const rawPayload = unbase64url(encodedPayload);
    if (!rawPayload) return null;

    let payload: AttachmentTokenPayload;
    try {
        payload = JSON.parse(rawPayload) as AttachmentTokenPayload;
    } catch {
        return null;
    }

    if (payload.v !== 1) return null;
    if (!payload.userId || !payload.attachmentId) return null;
    if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(nowMs / 1000)) return null;
    return payload;
}
