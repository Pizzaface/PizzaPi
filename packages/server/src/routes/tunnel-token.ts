import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getAuthContext } from "../auth.js";
import { getActiveRelaySessionUserId } from "../sessions/store.js";
import { getRunnerData } from "../ws/sio-registry.js";

export const TUNNEL_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Stable audience claim for all tunnel tokens. */
export const TUNNEL_TOKEN_AUD = "pizzapi:tunnel";

export interface TunnelTokenPayload {
    v: 1;
    userId: string;
    sessionId: string;
    port: number;
    exp: number;
    // v2 claims — absent on legacy tokens signed before this change
    aud?: string;
    iat?: number;
    kid?: string;
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

/**
 * Derive a short key-id from a secret so callers can route to the right key
 * without transmitting the secret. Uses first 8 hex chars of SHA256.
 */
function deriveKid(secret: string): string {
    return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 8);
}

/**
 * Dedicated tunnel-token signing secret.
 * Set PIZZAPI_TUNNEL_TOKEN_SECRET to isolate tunnel tokens from Better Auth
 * session secrets. Falls back to the Better Auth secret when unset so
 * unconfigured deploys keep working without code changes.
 *
 * Rotation: set PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS to the old secret;
 * tokens signed with it are still accepted until they expire (up to 1 h).
 */
function getTunnelSecret(): string {
    return process.env.PIZZAPI_TUNNEL_TOKEN_SECRET ?? getAuthContext().config.secret;
}

function getPreviousSecret(): string | null {
    return process.env.PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS ?? null;
}

function signPayload(encodedPayload: string, secret: string): string {
    return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function signaturesMatch(actual: string, expected: string): boolean {
    const a = Buffer.from(actual);
    const e = Buffer.from(expected);
    return a.length === e.length && timingSafeEqual(a, e);
}

export function createTunnelToken(
    input: { userId: string; sessionId: string; port: number },
    nowMs = Date.now(),
): { token: string; expiresAt: string } {
    const secret = getTunnelSecret();
    const exp = Math.floor((nowMs + TUNNEL_TOKEN_TTL_MS) / 1000);
    const iat = Math.floor(nowMs / 1000);
    const kid = deriveKid(secret);
    const payload: TunnelTokenPayload = {
        v: 1,
        userId: input.userId,
        sessionId: input.sessionId,
        port: input.port,
        exp,
        aud: TUNNEL_TOKEN_AUD,
        iat,
        kid,
    };
    const encodedPayload = base64url(JSON.stringify(payload));
    const signature = signPayload(encodedPayload, secret);
    return { token: `${encodedPayload}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyTunnelToken(token: string, nowMs = Date.now()): TunnelTokenPayload | null {
    const [encodedPayload, signature, extra] = token.split(".");
    if (!encodedPayload || !signature || extra !== undefined) return null;

    const rawPayload = unbase64url(encodedPayload);
    if (!rawPayload) return null;

    let payload: TunnelTokenPayload;
    try {
        payload = JSON.parse(rawPayload) as TunnelTokenPayload;
    } catch {
        return null;
    }

    const secret = getTunnelSecret();
    const prevSecret = getPreviousSecret();

    let verified = false;

    if (payload.kid) {
        // v2 path: match by kid, then verify signature with the matching key.
        const currentKid = deriveKid(secret);
        if (payload.kid === currentKid) {
            verified = signaturesMatch(signature, signPayload(encodedPayload, secret));
        } else if (prevSecret) {
            const prevKid = deriveKid(prevSecret);
            if (payload.kid === prevKid) {
                // ponytail: previous-key window; tokens accepted until their own exp
                verified = signaturesMatch(signature, signPayload(encodedPayload, prevSecret));
            }
        }
        if (!verified) return null;
        if (payload.aud !== TUNNEL_TOKEN_AUD) return null;
    } else {
        // Legacy path: tokens pre-dating aud/iat/kid claims. Verify signature
        // against current secret (or previous if set) and accept during the
        // natural 1-h TTL window. Log a deprecation warning.
        //
        // Policy: legacy tokens are accepted until they expire. After the 1-h
        // window they are gone; no permanent compat shim is needed.
        verified = signaturesMatch(signature, signPayload(encodedPayload, secret));
        if (!verified && prevSecret) {
            verified = signaturesMatch(signature, signPayload(encodedPayload, prevSecret));
        }
        if (!verified) return null;
        // ponytail: legacy token accepted; log once, no metric infra needed yet
        console.warn("[tunnel-token] deprecated: token missing aud/kid — re-mint to get v2 claims");
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
