/**
 * Runner Settings router — read/write runner config.json and settings.json.
 *
 * Endpoints:
 *   GET  /api/runners/:id/settings  — fetch full config + TUI settings
 *   PUT  /api/runners/:id/settings  — update a specific config section
 */

import { getRunnerData } from "../ws/sio-registry.js";
import { sendRunnerCommand } from "../ws/namespaces/runner.js";
import { requireSession } from "../middleware.js";
import type { RouteHandler } from "./types.js";

const SETTINGS_RE = /^\/api\/runners\/([^/]+)\/settings$/;

/** Valid section names for PUT updates. */
const VALID_SECTIONS = new Set([
    "models",
    "mcpServers",
    "hooks",
    "sandbox",
    "webSearch",
    "security",
    "envVars",
    "systemPrompt",
    "tuiPreferences",
    "agentsMd",
]);

export const handleRunnerSettingsRoute: RouteHandler = async (req, url) => {
    const match = url.pathname.match(SETTINGS_RE);
    if (!match) return undefined;

    const runnerId = decodeURIComponent(match[1]);

    // ── GET /api/runners/:id/settings ──────────────────────────────────
    if (req.method === "GET") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        try {
            const result = await sendRunnerCommand(runnerId, { type: "settings_get_config" }) as any;
            if (result && result.ok === false) {
                return Response.json({ error: result.message ?? "Failed to read settings" }, { status: 502 });
            }
            return Response.json(result);
        } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
        }
    }

    // ── PUT /api/runners/:id/settings ──────────────────────────────────
    if (req.method === "PUT") {
        const identity = await requireSession(req);
        if (identity instanceof Response) return identity;

        const runner = await getRunnerData(runnerId);
        if (!runner) return Response.json({ error: "Runner not found" }, { status: 404 });
        if (runner.userId !== identity.userId) return Response.json({ error: "Forbidden" }, { status: 403 });

        let body: any;
        try {
            body = await req.json();
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
        }

        const { section, value } = body;
        if (typeof section !== "string" || !VALID_SECTIONS.has(section)) {
            return Response.json(
                { error: `Invalid section "${section}". Valid: ${[...VALID_SECTIONS].join(", ")}` },
                { status: 400 },
            );
        }

        if (value === undefined) {
            return Response.json({ error: "Missing 'value' field" }, { status: 400 });
        }

        try {
            const result = await sendRunnerCommand(
                runnerId,
                { type: "settings_update_section", section, value },
            ) as any;
            if (result && result.ok === false) {
                return Response.json({ error: result.message ?? "Failed to update settings" }, { status: 502 });
            }
            return Response.json(result);
        } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
        }
    }

    return undefined;
};
