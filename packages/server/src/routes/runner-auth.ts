/**
 * Model provider auth router — log providers in from the web UI.
 *
 * Endpoints:
 *   GET  /api/runners/:id/providers               — providers that support login
 *   POST /api/runners/:id/providers/login         — start a login {providerId, authType}
 *   POST /api/runners/:id/providers/login/submit  — answer the flow {loginId, value}
 *   POST /api/runners/:id/providers/login/cancel  — abandon an in-flight login
 *
 * The runner owns the login conversation (see daemon-handlers/provider-auth.ts);
 * this router is a thin authenticated pass-through. `value` can carry an API
 * key, so responses never echo submitted input back.
 */

import { getRunnerData } from "../ws/sio-registry.js";
import { sendRunnerCommand } from "../ws/namespaces/runner.js";
import { requireSession } from "../middleware.js";
import type { RouteHandler } from "./types.js";

const PROVIDERS_RE = /^\/api\/runners\/([^/]+)\/providers(\/login(\/submit|\/cancel|\/status)?)?$/;

export const handleRunnerAuthRoute: RouteHandler = async (req, url) => {
    const match = url.pathname.match(PROVIDERS_RE);
    if (!match) return undefined;

    const runnerId = decodeURIComponent(match[1]);
    const sub = match[3] ?? match[2] ?? "";

    const identity = await requireSession(req);
    if (identity instanceof Response) return identity;

    const runner = await getRunnerData(runnerId);
    if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
    if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

    const run = async (command: Record<string, unknown>, timeoutMs?: number) => {
        try {
            const result = (await sendRunnerCommand(runnerId, command, timeoutMs)) as Record<string, unknown>;
            if (result && result.ok === false) {
                return Response.json({ error: result.message ?? "Runner rejected the request" }, { status: 502 });
            }
            return Response.json(result);
        } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
        }
    };

    if (req.method === "GET" && sub === "") {
        return run({ type: "auth_list" });
    }

    // Polled while a login card is open: the provider's loopback callback can
    // complete the flow without the user pasting anything.
    if (req.method === "GET" && sub === "/status") {
        const loginId = url.searchParams.get("loginId");
        if (!loginId) return Response.json({ error: "Missing 'loginId'" }, { status: 400 });
        return run({ type: "auth_login_status", loginId });
    }

    if (req.method !== "POST") return undefined;

    let body: any;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (sub === "/login") {
        if (typeof body?.providerId !== "string" || !body.providerId) {
            return Response.json({ error: "Missing 'providerId'" }, { status: 400 });
        }
        const authType = body.authType === "api_key" ? "api_key" : "oauth";
        // Login waits on a human in a browser; give the runner room to reply.
        return run({ type: "auth_login_start", providerId: body.providerId, authType }, 45_000);
    }

    if (sub === "/submit") {
        if (typeof body?.loginId !== "string" || typeof body?.value !== "string") {
            return Response.json({ error: "Missing 'loginId' or 'value'" }, { status: 400 });
        }
        return run({ type: "auth_login_submit", loginId: body.loginId, value: body.value }, 90_000);
    }

    if (sub === "/cancel") {
        if (typeof body?.loginId !== "string") {
            return Response.json({ error: "Missing 'loginId'" }, { status: 400 });
        }
        return run({ type: "auth_login_cancel", loginId: body.loginId });
    }

    return undefined;
};
