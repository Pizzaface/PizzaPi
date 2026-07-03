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

/**
 * Requires a genuine interactive browser (better-auth cookie) session. Unlike
 * requireSession, this does NOT fall back to API-key auth — use it for
 * privileged actions like approving a device enrollment, where an API key
 * (including a leaked mobile/ephemeral key) must never be sufficient.
 */
export async function requireBrowserSession(
    req: Request,
): Promise<{ userId: string; userName: string } | Response> {
    const session = await getAuth().api.getSession({ headers: req.headers });
    if (session?.user?.id) {
        return { userId: session.user.id, userName: session.user.name ?? session.user.id };
    }
    return new Response("Interactive browser session required", { status: 401 });
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
