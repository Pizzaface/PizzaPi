import { createHmac, timingSafeEqual } from "node:crypto";
import { getAuthContext } from "../auth.js";

export const TUNNEL_TOKEN_TTL_MS = 60 * 60 * 1000;

export interface TunnelTokenPayload {
    v: 1;
    userId: string;
    sessionId: string;
    port: number;
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

export function createTunnelToken(input: { userId: string; sessionId: string; port: number }, nowMs = Date.now()): { token: string; expiresAt: string } {
    const exp = Math.floor((nowMs + TUNNEL_TOKEN_TTL_MS) / 1000);
    const payload: TunnelTokenPayload = { v: 1, userId: input.userId, sessionId: input.sessionId, port: input.port, exp };
    const encodedPayload = base64url(JSON.stringify(payload));
    const signature = sign(encodedPayload);
    return { token: `${encodedPayload}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyTunnelToken(token: string, nowMs = Date.now()): TunnelTokenPayload | null {
    const [encodedPayload, signature, extra] = token.split(".");
    if (!encodedPayload || !signature || extra !== undefined) return null;

    const expected = sign(encodedPayload);
    const actualBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) return null;

    const rawPayload = unbase64url(encodedPayload);
    if (!rawPayload) return null;

    let payload: TunnelTokenPayload;
    try {
        payload = JSON.parse(rawPayload) as TunnelTokenPayload;
    } catch {
        return null;
    }

    if (payload.v !== 1) return null;
    if (!payload.userId || !payload.sessionId) return null;
    if (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535) return null;
    if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(nowMs / 1000)) return null;
    return payload;
}

export function getAuthTunnelBasePath(token: string, sessionId: string, port: number): string {
    return `/api/tunnel/auth/${encodeURIComponent(token)}/${encodeURIComponent(sessionId)}/${port}`;
}
