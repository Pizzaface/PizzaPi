// ============================================================================
// auth.ts — Socket.IO authentication middleware factories
//
// Three middleware factories:
//   1. apiKeyAuthMiddleware()          — for /relay and /runner namespaces
//   2. sessionCookieAuthMiddleware()   — for /viewer, /terminal, /hub namespaces
//   3. runnerAuthMiddleware()          — for /runner: API key OR org-scoped JWT
//
// Each validates credentials from the Socket.IO handshake and populates
// socket.data with userId and userName on success.
// ============================================================================

import type { Socket } from "socket.io";
import { auth, kysely, trustedOrigins } from "../../auth.js";
import { isMultiTenant } from "../../middleware/org-context.js";
import { jwtVerify, createRemoteJWKSet } from "jose";

/**
 * Middleware for /relay and /runner namespaces.
 *
 * Extracts the API key from `socket.handshake.auth.apiKey`, validates it
 * via better-auth's `verifyApiKey`, and sets `socket.data.userId` and
 * `socket.data.userName`.
 *
 * Rejects with `next(new Error("unauthorized"))` if the key is missing or invalid.
 */
export function apiKeyAuthMiddleware() {
    return async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
        try {
            const apiKey = socket.handshake.auth?.apiKey;
            if (typeof apiKey !== "string" || !apiKey) {
                return next(new Error("unauthorized"));
            }

            const result = await auth.api.verifyApiKey({ body: { key: apiKey } });
            if (!result.valid || !result.key?.userId) {
                return next(new Error("unauthorized"));
            }

            const userId = result.key.userId;
            const row = await kysely
                .selectFrom("user")
                .select("name")
                .where("id", "=", userId)
                .executeTakeFirst();

            socket.data.userId = userId;
            socket.data.userName = row?.name ?? userId;
            next();
        } catch {
            next(new Error("unauthorized"));
        }
    };
}

/**
 * Middleware for /viewer, /terminal, and /hub namespaces.
 *
 * Extracts the session cookie from `socket.handshake.headers.cookie`,
 * validates the session via better-auth's `getSession()`, and sets
 * `socket.data.userId` and `socket.data.userName`.
 *
 * Rejects with `next(new Error("unauthorized"))` if no valid session exists.
 */
export function sessionCookieAuthMiddleware() {
    return async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
        try {
            // Validate Origin header to prevent Cross-Site WebSocket Hijacking (CSWSH).
            // Browser WebSocket connections always include an Origin header; if the origin
            // is not in our trusted list, reject the connection before processing cookies.
            const origin = socket.handshake.headers.origin;
            if (origin && !trustedOrigins.includes(origin)) {
                return next(new Error("forbidden: untrusted origin"));
            }

            const cookieHeader = socket.handshake.headers.cookie;
            if (!cookieHeader) {
                return next(new Error("unauthorized"));
            }

            const headers = new Headers();
            headers.set("cookie", cookieHeader);

            const session = await auth.api.getSession({ headers });
            if (!session?.user?.id) {
                return next(new Error("unauthorized"));
            }

            socket.data.userId = session.user.id;
            socket.data.userName = session.user.name ?? session.user.id;
            next();
        } catch {
            next(new Error("unauthorized"));
        }
    };
}

// ── JWKS cache for runner JWT auth ──────────────────────────────────────────

let _runnerJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let _runnerJWKSAt = 0;
const JWKS_TTL_MS = 5 * 60 * 1000;

function getRunnerJWKS(url: string): ReturnType<typeof createRemoteJWKSet> {
    const now = Date.now();
    if (_runnerJWKS && now - _runnerJWKSAt < JWKS_TTL_MS) return _runnerJWKS;
    _runnerJWKS = createRemoteJWKSet(new URL(url));
    _runnerJWKSAt = now;
    return _runnerJWKS;
}

/**
 * Middleware for /runner namespace that accepts EITHER:
 *   - API key auth (existing single-tenant flow)
 *   - Org-scoped JWT with `type: "runner"` (multi-tenant flow)
 *
 * In multi-tenant mode (`ORG_ID` set), a JWT token can be provided via:
 *   - `socket.handshake.auth.token` (Socket.IO auth object)
 *   - `?token=<jwt>` query parameter on the WebSocket URL
 *
 * The JWT must contain `type: "runner"` and an `org_id` claim matching
 * the server's `ORG_ID` env var.
 *
 * When `ORG_ID` is not set, falls back to API key auth only.
 */
export function runnerAuthMiddleware() {
    return async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
        // Try API key auth first (works in both single- and multi-tenant)
        const apiKey = socket.handshake.auth?.apiKey;
        if (typeof apiKey === "string" && apiKey) {
            // Delegate to API key validation
            try {
                const result = await auth.api.verifyApiKey({ body: { key: apiKey } });
                if (result.valid && result.key?.userId) {
                    const userId = result.key.userId;
                    const row = await kysely
                        .selectFrom("user")
                        .select("name")
                        .where("id", "=", userId)
                        .executeTakeFirst();

                    socket.data.userId = userId;
                    socket.data.userName = row?.name ?? userId;
                    return next();
                }
            } catch {
                // API key invalid — fall through to JWT check
            }
        }

        // Try org-scoped JWT auth (multi-tenant only)
        if (!isMultiTenant()) {
            return next(new Error("unauthorized"));
        }

        const orgId = process.env.ORG_ID!;
        const jwksUrl = process.env.JWT_JWKS_URL;
        if (!jwksUrl) {
            console.error("[runner-auth] ORG_ID set but JWT_JWKS_URL missing");
            return next(new Error("unauthorized"));
        }

        // Extract JWT from auth object or query param
        const token =
            (typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : null) ??
            (typeof socket.handshake.query?.token === "string" ? socket.handshake.query.token : null);

        if (!token) {
            return next(new Error("unauthorized"));
        }

        try {
            const jwks = getRunnerJWKS(jwksUrl);
            const { payload } = await jwtVerify(token, jwks);

            // Must be a runner token
            const tokenType = (payload as any).type;
            if (tokenType !== "runner") {
                return next(new Error("unauthorized: invalid token type"));
            }

            // Org must match
            const tokenOrgId = (payload as any).org_id ?? (payload as any).orgId;
            if (tokenOrgId !== orgId) {
                return next(new Error("forbidden: organization mismatch"));
            }

            socket.data.userId = (payload.sub ?? (payload as any).user_id ?? "") as string;
            socket.data.userName = ((payload as any).name ?? socket.data.userId) as string;
            return next();
        } catch (err: any) {
            const msg = err?.code === "ERR_JWT_EXPIRED" ? "token expired" : "invalid token";
            return next(new Error(`unauthorized: ${msg}`));
        }
    };
}
