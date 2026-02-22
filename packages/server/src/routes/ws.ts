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
        // TUI (CLI) connecting to register a live-share session — must present a valid API key (x-api-key header)
        const identity = await validateApiKey(req);
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
        // Runner daemon connecting — accepts API key (x-api-key) or legacy Bearer token
        const apiKeyHeader = req.headers.get("x-api-key");
        if (apiKeyHeader) {
            const identity = await validateApiKey(req);
            if (identity instanceof Response) return identity;
            const upgraded = server.upgrade(req, { data: { role: "runner", userId: identity.userId, userName: identity.userName } });
            if (upgraded) return;
            return new Response("WebSocket upgrade failed", { status: 400 });
        }
        const authHeader = req.headers.get("Authorization") ?? "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        const expected = process.env.PIZZAPI_RUNNER_TOKEN;
        if (!expected || !token || token !== expected) {
            return new Response("Unauthorized", { status: 401 });
        }
        const upgraded = server.upgrade(req, { data: { role: "runner" } });
        if (upgraded) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname.startsWith("/ws/terminal/")) {
        // Browser connecting to a terminal session — must have a valid session cookie
        const session = await auth.api.getSession({ headers: req.headers });
        if (!session) return new Response("Unauthorized", { status: 401 });
        const terminalId = url.pathname.slice("/ws/terminal/".length);
        if (!terminalId) return new Response("Missing terminal ID", { status: 400 });
        const upgraded = server.upgrade(req, {
            data: {
                role: "terminal" as const,
                terminalId,
                userId: session.user.id,
                userName: session.user.name,
            },
        });
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
