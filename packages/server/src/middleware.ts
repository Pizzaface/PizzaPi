import { auth, kysely } from "./auth.js";

/** Returns the session+user or a 401 Response. */
export async function requireSession(
    req: Request,
): Promise<{ userId: string; userName: string } | Response> {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session?.user?.id) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return { userId: session.user.id, userName: session.user.name ?? session.user.id };
}

/** Validates x-api-key header; returns user info or a 401 Response. */
export async function validateApiKey(
    req: Request,
): Promise<{ userId: string; userName: string } | Response> {
    const key = req.headers.get("x-api-key");
    if (!key) {
        return new Response("Missing x-api-key header", { status: 401 });
    }
    const result = await auth.api.verifyApiKey({ body: { key } });
    if (!result.valid || !result.key?.userId) {
        return new Response("Invalid or expired API key", { status: 401 });
    }
    const userId = result.key.userId;
    const row = await kysely
        .selectFrom("user")
        .select("name")
        .where("id", "=", userId)
        .executeTakeFirst();
    return { userId, userName: row?.name ?? userId };
}
