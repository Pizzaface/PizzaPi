/**
 * Org-context JWT middleware for multi-tenant mode.
 *
 * When `ORG_ID` env is set, validates JWTs from the control plane
 * and populates org context on the request. Otherwise acts as a no-op,
 * falling back to existing better-auth (single-tenant) flow.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

// ── Types ──────────────────────────────────────────────────────────────────

export interface OrgContext {
    userId: string;
    orgId: string;
    orgSlug: string;
    role: string;
}

/** Augmented request with org context attached by the middleware. */
export interface OrgRequest {
    orgContext?: OrgContext;
}

// ── JWKS cache (refreshed every 5 minutes via jose built-in) ───────────────

let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksCreatedAt = 0;
const JWKS_CACHE_MS = 5 * 60 * 1000;

function getJWKS(url: string): ReturnType<typeof createRemoteJWKSet> {
    const now = Date.now();
    if (cachedJWKS && now - jwksCreatedAt < JWKS_CACHE_MS) {
        return cachedJWKS;
    }
    cachedJWKS = createRemoteJWKSet(new URL(url));
    jwksCreatedAt = now;
    return cachedJWKS;
}

// ── Configuration ──────────────────────────────────────────────────────────

function getConfig() {
    const orgId = process.env.ORG_ID;
    const orgSlug = process.env.ORG_SLUG ?? "";
    const jwksUrl = process.env.JWT_JWKS_URL;
    return { orgId, orgSlug, jwksUrl };
}

/** Returns true when multi-tenant mode is active. */
export function isMultiTenant(): boolean {
    return !!process.env.ORG_ID;
}

// ── Token extraction ───────────────────────────────────────────────────────

function extractToken(req: Request): string | null {
    // 1. Authorization: Bearer <token>
    const authHeader = req.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
        return authHeader.slice(7);
    }

    // 2. org_token cookie
    const cookie = req.headers.get("cookie");
    if (cookie) {
        const match = cookie.match(/(?:^|;\s*)org_token=([^\s;]+)/);
        if (match) return match[1];
    }

    return null;
}

// ── Middleware ──────────────────────────────────────────────────────────────

// WeakMap to store org context per request (avoids mutating Request objects)
const requestContextMap = new WeakMap<Request, OrgContext>();

/** Retrieve org context previously set by the middleware. */
export function getOrgContext(req: Request): OrgContext | undefined {
    return requestContextMap.get(req);
}

/**
 * Validates the org JWT and populates org context on the request.
 *
 * Returns `null` when the request is allowed to proceed, or a `Response`
 * to short-circuit (401/403).
 *
 * When `ORG_ID` is not set (single-tenant mode), always returns `null` (no-op).
 */
export async function orgContextMiddleware(req: Request): Promise<Response | null> {
    const { orgId, orgSlug, jwksUrl } = getConfig();

    // Single-tenant mode — no-op
    if (!orgId) return null;

    if (!jwksUrl) {
        console.error("[org-context] ORG_ID is set but JWT_JWKS_URL is missing");
        return Response.json({ error: "Server misconfiguration" }, { status: 500 });
    }

    const token = extractToken(req);
    if (!token) {
        return Response.json({ error: "Missing authentication token" }, { status: 401 });
    }

    // Validate JWT
    let payload: JWTPayload;
    try {
        const jwks = getJWKS(jwksUrl);
        const result = await jwtVerify(token, jwks);
        payload = result.payload;
    } catch (err: any) {
        const message =
            err?.code === "ERR_JWT_EXPIRED" ? "Token expired" : "Invalid token";
        return Response.json({ error: message }, { status: 401 });
    }

    // Verify org_id claim matches this server's ORG_ID
    const tokenOrgId = (payload as any).org_id ?? (payload as any).orgId;
    if (tokenOrgId !== orgId) {
        return Response.json(
            { error: "Forbidden: organization mismatch" },
            { status: 403 },
        );
    }

    // Populate context
    const ctx: OrgContext = {
        userId: (payload.sub ?? (payload as any).user_id ?? "") as string,
        orgId,
        orgSlug: ((payload as any).org_slug as string) || orgSlug,
        role: ((payload as any).role as string) || "member",
    };

    requestContextMap.set(req, ctx);

    return null; // proceed
}
