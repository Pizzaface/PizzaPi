/**
 * Setup-claim routes — QR-code device enrollment.
 *
 * - POST /api/setup-claim              — unauthenticated; creates a pending claim.
 * - GET  /api/setup-claim/:token       — unauthenticated; poll/redeem a claim (one-shot key delivery, CLI only).
 * - GET  /api/setup-claim-info/:token  — unauthenticated; non-consuming status/label read for the approval UI.
 *
 * The info route deliberately sits OUTSIDE the /api/setup-claim/ prefix. Older
 * relays parse the poll route's token as
 * `pathname.slice("/api/setup-claim/".length).split("/")[0]`, so a nested
 * `/api/setup-claim/:token/info` request would hit their *consuming* poll
 * handler with a valid token and silently redeem an approved claim. The UI is
 * shipped as a separately versioned image from the server, so a newer UI WILL
 * meet an older server in the wild. A distinct prefix 404s there instead.
 * - POST /api/setup-claim/:token/approve — authenticated; approve and attach API key.
 */

import { requireEnrollmentAuth } from "../middleware.js";
import { RateLimiter, getClientIp } from "../security.js";
import {
    createSetupClaim,
    pollSetupClaim,
    approveSetupClaim,
    getSetupClaimInfo,
    normalizeSetupClaimRelayUrl,
    SETUP_CLAIM_RELAY_URL_MAX_LENGTH,
    SetupClaimRejectedError,
} from "../setup-claims.js";
import type { RouteHandler } from "./types.js";

/**
 * Per-client limit on unauthenticated claim creation. A CLI creates one claim
 * per setup attempt (or one per 10-minute expiry while waiting headless); the
 * headroom covers several runner containers pairing from behind one NAT.
 */
export const SETUP_CLAIM_CREATE_LIMIT_PER_CLIENT = 30;
export const SETUP_CLAIM_CREATE_WINDOW_MS = 10 * 60 * 1000;
const setupClaimCreateRateLimiter = new RateLimiter(SETUP_CLAIM_CREATE_LIMIT_PER_CLIENT, SETUP_CLAIM_CREATE_WINDOW_MS);

export const handleSetupClaimsRoute: RouteHandler = async (req, url) => {
    // Create a pending claim (called by the CLI during `pizzapi setup --scan`).
    if (url.pathname === "/api/setup-claim" && req.method === "POST") {
        // Unauthenticated durable write: throttle per client before parsing.
        const rateKey = `setup-claim:${getClientIp(req)}`;
        if (!setupClaimCreateRateLimiter.check(rateKey)) {
            return Response.json(
                { error: "Too many setup-claim requests. Please try again later." },
                { status: 429, headers: { "Retry-After": String(setupClaimCreateRateLimiter.getRetryAfter(rateKey)) } },
            );
        }

        let rawRelayUrl: unknown;
        let label: string | undefined;
        try {
            const body = (await req.json()) as { relayUrl?: unknown; label?: unknown };
            rawRelayUrl = body.relayUrl;
            label = typeof body.label === "string" ? body.label : undefined;
        } catch {
            rawRelayUrl = undefined;
        }
        if (typeof rawRelayUrl !== "string" || !rawRelayUrl.trim()) {
            return Response.json({ error: "Missing required field: relayUrl" }, { status: 400 });
        }
        const relayUrl = normalizeSetupClaimRelayUrl(rawRelayUrl);
        if (!relayUrl) {
            return Response.json(
                { error: `Invalid relayUrl: must be an http(s) URL of at most ${SETUP_CLAIM_RELAY_URL_MAX_LENGTH} characters` },
                { status: 400 },
            );
        }

        try {
            const { token, expiresAt } = await createSetupClaim(relayUrl, label);
            return Response.json({ token, expiresAt });
        } catch (err) {
            if (err instanceof SetupClaimRejectedError && err.reason === "quota_exceeded") {
                return Response.json(
                    { error: "Too many pending setup claims. Please try again later." },
                    { status: 429, headers: { "Retry-After": "60" } },
                );
            }
            throw err;
        }
    }

    // Non-consuming status/label read for the web approval UI (checked before the
    // poll/redeem route below — must NEVER fall through to the one-shot redeem).
    if (url.pathname.startsWith("/api/setup-claim-info/") && req.method === "GET") {
        const token = url.pathname.slice("/api/setup-claim-info/".length).split("/")[0];
        if (!token) {
            return Response.json({ error: "Missing claim token" }, { status: 400 });
        }
        const info = await getSetupClaimInfo(token);
        if (!info) {
            return Response.json({ error: "Unknown or expired claim" }, { status: 404 });
        }
        return Response.json(info);
    }

    // Poll/redeem a claim (called by the CLI every few seconds).
    if (url.pathname.startsWith("/api/setup-claim/") && req.method === "GET") {
        const token = url.pathname.slice("/api/setup-claim/".length).split("/")[0];
        if (!token) {
            return Response.json({ error: "Missing claim token" }, { status: 400 });
        }
        const claim = await pollSetupClaim(token);
        if (!claim) {
            return Response.json({ error: "Unknown or expired claim" }, { status: 404 });
        }
        return Response.json(claim);
    }

    // Approve a pending claim (from the authenticated web UI or mobile app).
    if (url.pathname.startsWith("/api/setup-claim/") && url.pathname.endsWith("/approve") && req.method === "POST") {
        const token = url.pathname.slice("/api/setup-claim/".length, -"/approve".length);
        if (!token) {
            return Response.json({ error: "Missing claim token" }, { status: 400 });
        }

        // Browser session OR API key; the minted CLI key is capped to the
        // approver's own lifetime so an API key can't escalate to a longer-lived
        // credential (see requireEnrollmentAuth).
        const identity = await requireEnrollmentAuth(req);
        if (identity instanceof Response) return identity;

        const result = await approveSetupClaim(token, identity.userId, identity.userName, identity.maxMintTtlSeconds);
        if (!result) {
            return Response.json({ error: "Claim not found, expired, or already processed" }, { status: 410 });
        }
        return Response.json({ ok: true });
    }

    return undefined;
};
