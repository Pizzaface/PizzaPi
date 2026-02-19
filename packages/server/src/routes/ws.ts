import type { WsData } from "../ws/registry.js";
import { validateApiKey } from "../middleware.js";
import { auth } from "../auth.js";

type BunServer = ReturnType<typeof Bun.serve<WsData>>;

export async function handleWsUpgrade(
    req: Request,
    url: URL,
    server: BunServer,
): Promise<Response | undefined> {
    if (url.pathname === "/ws/sessions") {
        // TUI (CLI) connecting to register a live-share session — must present a valid API key
        const identity = await validateApiKey(req, url.searchParams.get("apiKey") ?? undefined);
        if (identity instanceof Response) return identity;
        const upgraded = server.upgrade(req, {
            data: { role: "tui", userId: identity.userId, userName: identity.userName },
        });
        if (upgraded) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname.startsWith("/ws/sessions/")) {
        // Browser viewer connecting to watch a session — must have a valid session cookie
        const session = await auth.api.getSession({ headers: req.headers });
        if (!session) return new Response("Unauthorized", { status: 401 });
        const sessionId = url.pathname.slice("/ws/sessions/".length);
        if (!sessionId) return new Response("Missing session ID", { status: 400 });
        const upgraded = server.upgrade(req, {
            data: {
                role: "viewer",
                sessionId,
                userId: session.user.id,
                userName: session.user.name,
            },
        });
        if (upgraded) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/ws/runner") {
        // Runner daemon connecting — token passed as ?token=... query param
        const token = url.searchParams.get("token") ?? "";
        const expected = process.env.PIZZAPI_RUNNER_TOKEN;
        if (!expected || token !== expected) {
            return new Response("Unauthorized", { status: 401 });
        }
        const upgraded = server.upgrade(req, { data: { role: "runner" } });
        if (upgraded) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/ws/hub") {
        // Web UI connecting to watch the live session list — must have a valid session cookie
        const session = await auth.api.getSession({ headers: req.headers });
        if (!session) return new Response("Unauthorized", { status: 401 });
        const upgraded = server.upgrade(req, {
            data: {
                role: "hub",
                userId: session.user.id,
                userName: session.user.name,
            },
        });
        if (upgraded) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return undefined;
}
