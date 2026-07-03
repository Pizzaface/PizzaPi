import { getAuth, getKysely } from "./auth.js";

/** Returns the session+user or a 401 Response. Falls back to API-key auth. */
export async function requireSession(
    req: Request,
): Promise<{ userId: string; userName: string } | Response> {
    const session = await getAuth().api.getSession({ headers: req.headers });
    if (session?.user?.id) {
        return { userId: session.user.id, userName: session.user.name ?? session.user.id };
    }
    return validateApiKey(req);
}

export interface EnrollmentAuth {
    userId: string;
    userName: string;
    /**
     * Upper bound (seconds) on the lifetime of any credential this request may
     * mint, or null for no cap. An interactive browser session is uncapped; an
     * API key is capped to its OWN remaining lifetime so a key can never mint a
     * longer-lived credential than itself. This keeps device enrollment usable
     * from the mobile app (API-key auth) while blocking the escalation the hard
     * ban was written for: a short-lived / ephemeral key can't produce a
     * long-lived one, and an enrolled key can't outlive — and thus survive
     * revocation of — the key that approved it.
     */
    maxMintTtlSeconds: number | null;
}

/**
 * Auth gate for device-enrollment approval. Accepts an interactive browser
 * (cookie) session OR a valid API key, and reports how long a minted credential
 * is allowed to live (see EnrollmentAuth.maxMintTtlSeconds).
 */
export async function requireEnrollmentAuth(req: Request): Promise<EnrollmentAuth | Response> {
    const session = await getAuth().api.getSession({ headers: req.headers });
    if (session?.user?.id) {
        return { userId: session.user.id, userName: session.user.name ?? session.user.id, maxMintTtlSeconds: null };
    }
    const key = req.headers.get("x-api-key");
    if (!key) return new Response("Unauthorized", { status: 401 });
    const result = await getAuth().api.verifyApiKey({ body: { key } });
    if (!result.valid || !result.key?.userId) {
        return new Response("Invalid or expired API key", { status: 401 });
    }
    const userId = result.key.userId;
    const row = await getKysely()
        .selectFrom("user")
        .select("name")
        .where("id", "=", userId)
        .executeTakeFirst();
    // Cap to the approving key's own remaining lifetime (null = key never expires).
    const expMs = result.key.expiresAt ? new Date(result.key.expiresAt).getTime() : null;
    const maxMintTtlSeconds = expMs ? Math.max(0, Math.floor((expMs - Date.now()) / 1000)) : null;
    return { userId, userName: row?.name ?? userId, maxMintTtlSeconds };
}

/** Validates x-api-key header; returns user info or a 401 Response. */
export async function validateApiKey(
    req: Request,
    explicitKey?: string,
): Promise<{ userId: string; userName: string } | Response> {
    const key = explicitKey ?? req.headers.get("x-api-key");
    if (!key) {
        return new Response("Missing API key (x-api-key header)", { status: 401 });
    }
    const result = await getAuth().api.verifyApiKey({ body: { key } });
    if (!result.valid || !result.key?.userId) {
        return new Response("Invalid or expired API key", { status: 401 });
    }
    const userId = result.key.userId;
    const row = await getKysely()
        .selectFrom("user")
        .select("name")
        .where("id", "=", userId)
        .executeTakeFirst();
    return { userId, userName: row?.name ?? userId };
}
