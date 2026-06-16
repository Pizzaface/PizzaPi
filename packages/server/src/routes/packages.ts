/**
 * Package management routes — install/remove/list/update pi packages.
 *
 * Endpoints:
 *   GET  /api/runners/:id/packages          — list installed packages
 *   POST /api/runners/:id/packages/install  — install a package
 *   POST /api/runners/:id/packages/remove   — remove a package
 *   POST /api/runners/:id/packages/update   — update packages
 */

import { getRunnerData } from "../ws/sio-registry.js";
import { sendRunnerCommand } from "../ws/namespaces/runner.js";
import { requireSession } from "../middleware.js";
import type { RouteHandler } from "./types.js";

const PACKAGES_RE = /^\/api\/runners\/([^/]+)\/packages(?:\/(install|remove|update))?$/;

export const handlePackagesRoute: RouteHandler = async (req, url) => {
    const match = url.pathname.match(PACKAGES_RE);
    if (!match) return undefined;

    const runnerId = decodeURIComponent(match[1]);
    const action = match[2]; // undefined for list, or "install"/"remove"/"update"

    // All endpoints require authentication
    const identity = await requireSession(req);
    if (identity instanceof Response) return identity;

    const runner = await getRunnerData(runnerId);
    if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
    if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

    // ── GET /api/runners/:id/packages (list) ──────────────────────────────
    if (req.method === "GET" && !action) {
        try {
            const result = await sendRunnerCommand(runnerId, {
                type: "packages_list",
            }) as any;
            return Response.json(result);
        } catch (err) {
            return Response.json(
                { error: err instanceof Error ? err.message : String(err) },
                { status: 502 },
            );
        }
    }

    // All other endpoints require POST
    if (req.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    let body: any;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { source, local } = body;

    // ── POST /api/runners/:id/packages/install ────────────────────────────
    if (action === "install") {
        if (!source || typeof source !== "string") {
            return Response.json({ error: "Missing or invalid 'source'" }, { status: 400 });
        }

        try {
            const result = await sendRunnerCommand(runnerId, {
                type: "packages_install",
                source,
                local: local === true,
            }) as any;
            return Response.json(result);
        } catch (err) {
            return Response.json(
                { error: err instanceof Error ? err.message : String(err) },
                { status: 502 },
            );
        }
    }

    // ── POST /api/runners/:id/packages/remove ─────────────────────────────
    if (action === "remove") {
        if (!source || typeof source !== "string") {
            return Response.json({ error: "Missing or invalid 'source'" }, { status: 400 });
        }

        try {
            const result = await sendRunnerCommand(runnerId, {
                type: "packages_remove",
                source,
                local: local === true,
            }) as any;
            return Response.json(result);
        } catch (err) {
            return Response.json(
                { error: err instanceof Error ? err.message : String(err) },
                { status: 502 },
            );
        }
    }

    // ── POST /api/runners/:id/packages/update ─────────────────────────────
    if (action === "update") {
        // source is optional for update (update all if not specified)
        if (source !== undefined && typeof source !== "string") {
            return Response.json({ error: "'source' must be a string if provided" }, { status: 400 });
        }

        try {
            const result = await sendRunnerCommand(runnerId, {
                type: "packages_update",
                source,
            }) as any;
            return Response.json(result);
        } catch (err) {
            return Response.json(
                { error: err instanceof Error ? err.message : String(err) },
                { status: 502 },
            );
        }
    }

    return undefined;
};
