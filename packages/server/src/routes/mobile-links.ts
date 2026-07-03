import { requireEnrollmentAuth, requireSession } from "../middleware.js";
import { getTrustedOrigins } from "../auth.js";
import { approveMobileLink, createMobileLink, getMobileLink, redeemMobileLink, scanMobileLink } from "../mobile-links.js";
import type { RouteHandler } from "./types.js";

function cleanString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

// Capacitor-based mobile clients send opaque origins; keep this list minimal
// and match only the exact schemes the app is known to use.
// ponytail: capacitor-origin exception — these origins are hard-coded because
// the mobile runtime sends opaque/null origins and cannot participate in the
// better-auth trustedOrigins list.
const KNOWN_CAPACITOR_ORIGINS = [
    "capacitor://localhost",
    "http://localhost",
    "ionic://localhost",
    "null",
];

function safeTrustedOrigins(): string[] {
    // getTrustedOrigins() reads the AsyncLocalStorage auth context and throws
    // when none is bound (e.g. the unauthenticated CORS preflight path). Fall
    // back to an empty list so the Capacitor-origin allowlist below still works.
    try {
        return getTrustedOrigins();
    } catch {
        return [];
    }
}

export function mobileCorsHeaders(req: Request, trustedOrigins?: string[]): Record<string, string> {
    const origins = trustedOrigins ?? safeTrustedOrigins();
    const origin = req.headers.get("origin");
    const allowedOrigin =
        origin && (origins.includes(origin) || KNOWN_CAPACITOR_ORIGINS.includes(origin))
            ? origin
            : (origins[0] ?? "*");
    return {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Vary": "Origin",
    };
}

function mobileJson(req: Request, body: unknown, init?: ResponseInit): Response {
    return Response.json(body, {
        ...init,
        headers: { ...mobileCorsHeaders(req), ...init?.headers },
    });
}

export const handleMobileLinksRoute: RouteHandler = async (req, url) => {
    if (url.pathname.startsWith("/api/mobile-link/") && req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: mobileCorsHeaders(req) });
    }
    if (url.pathname === "/api/mobile-link" && req.method === "POST") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        let relayUrl = "";
        try {
            const body = (await req.json()) as { relayUrl?: string };
            relayUrl = cleanString(body.relayUrl);
        } catch {
            relayUrl = "";
        }
        if (!relayUrl) return Response.json({ error: "Missing required field: relayUrl" }, { status: 400 });

        return Response.json(await createMobileLink(relayUrl, identity.userId, identity.userName));
    }

    if (url.pathname.startsWith("/api/mobile-link/") && url.pathname.endsWith("/scan") && req.method === "POST") {
        const id = url.pathname.slice("/api/mobile-link/".length, -"/scan".length);
        if (!id) return Response.json({ error: "Missing mobile link id" }, { status: 400 });

        let verificationToken = "";
        let deviceName = "";
        let scannedUrl = "";
        try {
            const body = (await req.json()) as { verificationToken?: string; deviceName?: string; scannedUrl?: string };
            verificationToken = cleanString(body.verificationToken);
            deviceName = cleanString(body.deviceName);
            scannedUrl = cleanString(body.scannedUrl);
        } catch {
            verificationToken = "";
        }
        if (!/^[A-Z0-9]{6}$/.test(verificationToken)) {
            return mobileJson(req, { error: "verificationToken must be 6 uppercase letters/digits" }, { status: 400 });
        }

        const claim = await scanMobileLink(id, { verificationToken, deviceName, scannedUrl });
        if (!claim) return mobileJson(req, { error: "Unknown or expired mobile link" }, { status: 404 });
        return mobileJson(req, claim);
    }

    if (url.pathname.startsWith("/api/mobile-link/") && url.pathname.endsWith("/approve") && req.method === "POST") {
        const id = url.pathname.slice("/api/mobile-link/".length, -"/approve".length);
        if (!id) return Response.json({ error: "Missing mobile link id" }, { status: 400 });

        // Browser session OR API key; the minted device key is capped to the
        // approver's own lifetime so an API key can't escalate (see
        // requireEnrollmentAuth).
        const identity = await requireEnrollmentAuth(req);
        if (identity instanceof Response) return identity;

        let verificationToken = "";
        try {
            const body = (await req.json()) as { verificationToken?: string };
            verificationToken = cleanString(body.verificationToken);
        } catch {
            verificationToken = "";
        }
        if (!/^[A-Z0-9]{6}$/.test(verificationToken)) {
            return Response.json({ error: "verificationToken must be 6 uppercase letters/digits" }, { status: 400 });
        }

        const claim = await approveMobileLink(id, identity.userId, verificationToken, identity.maxMintTtlSeconds);
        if (!claim) return Response.json({ error: "Mobile link not found, expired, or not ready" }, { status: 410 });
        return Response.json(claim);
    }

    if (url.pathname.startsWith("/api/mobile-link/") && url.pathname.endsWith("/redeem") && req.method === "POST") {
        const id = url.pathname.slice("/api/mobile-link/".length, -"/redeem".length);
        if (!id) return mobileJson(req, { error: "Missing mobile link id" }, { status: 400 });

        const claim = await redeemMobileLink(id);
        if (!claim) return mobileJson(req, { error: "Unknown or expired mobile link" }, { status: 404 });
        if (claim.status !== "approved") return mobileJson(req, { error: "Mobile link not approved" }, { status: 410 });
        if (!claim.apiKey) return mobileJson(req, { error: "Mobile link already redeemed" }, { status: 410 });
        return mobileJson(req, claim);
    }

    if (url.pathname.startsWith("/api/mobile-link/") && req.method === "GET") {
        const id = url.pathname.slice("/api/mobile-link/".length).split("/")[0];
        if (!id) return mobileJson(req, { error: "Missing mobile link id" }, { status: 400 });
        const claim = await getMobileLink(id);
        if (!claim) return mobileJson(req, { error: "Unknown or expired mobile link" }, { status: 404 });
        return mobileJson(req, claim);
    }

    return undefined;
};
