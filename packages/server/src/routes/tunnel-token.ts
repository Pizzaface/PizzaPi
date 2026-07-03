import { createHmac, timingSafeEqual } from "node:crypto";
import { getAuthContext } from "../auth.js";
import { getActiveRelaySessionUserId } from "../sessions/store.js";
import { getRunnerData } from "../ws/sio-registry.js";

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

/**
 * Re-verify a syntactically valid tunnel token against the current ownership
 * state. Callers should invoke this after verifyTunnelToken() succeeds on the
 * consume path. Throws if the underlying session has ended or changed owners,
 * or if the runner-scoped session sentinel no longer resolves to a runner
 * owned by payload.userId.
 *
 * ponytail: this closes the up-to-1h window when a session/runner is revoked,
 * but the tokens are still bearer tokens (whoever holds the URL can use it).
 */
export async function assertTunnelTokenStillValid(payload: TunnelTokenPayload): Promise<void> {
    if (payload.sessionId.startsWith("runner:")) {
        const runnerId = payload.sessionId.slice("runner:".length);
        const runner = await getRunnerData(runnerId);
        if (!runner || runner.userId !== payload.userId) {
            throw new Error("Tunnel token revoked");
        }
        return;
    }

    const ownerId = await getActiveRelaySessionUserId(payload.sessionId);
    if (ownerId !== payload.userId) {
        throw new Error("Tunnel token revoked");
    }
}

export function getAuthTunnelBasePath(token: string, sessionId: string, port: number): string {
    return `/api/tunnel/auth/${encodeURIComponent(token)}/${encodeURIComponent(sessionId)}/${port}`;
}
