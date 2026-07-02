/**
 * Setup-claim routes — QR-code device enrollment.
 *
 * - POST /api/setup-claim         — unauthenticated; creates a pending claim.
 * - GET  /api/setup-claim/:token  — unauthenticated; poll/redeem a claim.
 * - POST /api/setup-claim/:token/approve — authenticated; approve and attach API key.
 */

import { requireSession } from "../middleware.js";
import { createSetupClaim, pollSetupClaim, approveSetupClaim } from "../setup-claims.js";
import type { RouteHandler } from "./types.js";

export const handleSetupClaimsRoute: RouteHandler = async (req, url) => {
    // Create a pending claim (called by the CLI during `pizzapi setup --scan`).
    if (url.pathname === "/api/setup-claim" && req.method === "POST") {
        let relayUrl = "";
        try {
            const body = (await req.json()) as { relayUrl?: string };
            relayUrl = typeof body.relayUrl === "string" ? body.relayUrl.trim() : "";
        } catch {
            relayUrl = "";
        }
        if (!relayUrl) {
            return Response.json({ error: "Missing required field: relayUrl" }, { status: 400 });
        }

        const { token, expiresAt } = await createSetupClaim(relayUrl);
        return Response.json({ token, expiresAt });
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

    // Approve a pending claim (called by the authenticated web UI).
    if (url.pathname.startsWith("/api/setup-claim/") && url.pathname.endsWith("/approve") && req.method === "POST") {
        const token = url.pathname.slice("/api/setup-claim/".length, -"/approve".length);
        if (!token) {
            return Response.json({ error: "Missing claim token" }, { status: 400 });
        }

        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const result = await approveSetupClaim(token, identity.userId, identity.userName);
        if (!result) {
            return Response.json({ error: "Claim not found, expired, or already processed" }, { status: 410 });
        }
        return Response.json({ ok: true });
    }

    return undefined;
};
