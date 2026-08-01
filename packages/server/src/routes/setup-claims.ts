/**
 * Setup-claim routes — QR-code device enrollment.
 *
 * - POST /api/setup-claim              — unauthenticated; creates a pending claim.
 * - GET  /api/setup-claim/:token       — unauthenticated; poll/redeem a claim (one-shot key delivery, CLI only).
 * - GET  /api/setup-claim/:token/info  — unauthenticated; non-consuming status/label read for the approval UI.
 * - POST /api/setup-claim/:token/approve — authenticated; approve and attach API key.
 */

import { requireEnrollmentAuth } from "../middleware.js";
import { createSetupClaim, pollSetupClaim, approveSetupClaim, getSetupClaimInfo } from "../setup-claims.js";
import type { RouteHandler } from "./types.js";

export const handleSetupClaimsRoute: RouteHandler = async (req, url) => {
    // Create a pending claim (called by the CLI during `pizzapi setup --scan`).
    if (url.pathname === "/api/setup-claim" && req.method === "POST") {
        let relayUrl = "";
        let label: string | undefined;
        try {
            const body = (await req.json()) as { relayUrl?: string; label?: string };
            relayUrl = typeof body.relayUrl === "string" ? body.relayUrl.trim() : "";
            label = typeof body.label === "string" ? body.label : undefined;
        } catch {
            relayUrl = "";
        }
        if (!relayUrl) {
            return Response.json({ error: "Missing required field: relayUrl" }, { status: 400 });
        }

        const { token, expiresAt } = await createSetupClaim(relayUrl, label);
        return Response.json({ token, expiresAt });
    }

    // Non-consuming status/label read for the web approval UI (checked before the
    // poll/redeem route below — must NEVER fall through to the one-shot redeem).
    if (url.pathname.startsWith("/api/setup-claim/") && url.pathname.endsWith("/info") && req.method === "GET") {
        const token = url.pathname.slice("/api/setup-claim/".length, -"/info".length);
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
