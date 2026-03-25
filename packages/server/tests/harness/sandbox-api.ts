/**
 * 🍕 Sandbox HTTP Control API
 *
 * Exposes sandbox commands as REST endpoints so agents and scripts can
 * drive the sandbox programmatically without stdin/REPL pipes.
 *
 * Starts on a separate port from the PizzaPi server.
 *
 * Endpoints:
 *   GET  /status          — list all sessions
 *   POST /session         — create a new session { name?, model?, cwd? }
 *   POST /chat            — stream a conversation { session: number, scenario?: string }
 *   POST /oauth           — simulate MCP OAuth paste prompt { session: number, server?: string }
 *   POST /child           — spawn a child session { parent: number }
 *   POST /end             — end a session { session: number }
 *   POST /heartbeat       — send heartbeat { session: number, active?: boolean }
 *   GET  /credentials     — get login credentials (email, password, apiKey)
 */

import type { TestScenario, ScenarioSession } from "./scenario.js";
import { buildHeartbeat } from "./builders.js";

export interface SandboxApiOptions {
    scenario: TestScenario;
    /** Pre-built conversation scenario builders */
    scenarios: Record<string, { name: string; builder: () => unknown[] }>;
    /** Model pool for random selection */
    models: Array<{ provider: string; id: string; name: string; contextWindow: number }>;
    /** Working directories pool */
    cwds: string[];
    /** Port to listen on (0 = auto) */
    port?: number;
}

export interface SandboxApi {
    /** Base URL of the control API (e.g. "http://127.0.0.1:56200") */
    baseUrl: string;
    /** Port the control API is listening on */
    port: number;
    /** Stop the control API server */
    stop: () => void;
}

function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Session counter — incremented for each new session. */
let sessionCounter = 0;

/**
 * Start the sandbox HTTP control API.
 */
export async function startSandboxApi(opts: SandboxApiOptions): Promise<SandboxApi> {
    const { scenario, scenarios, models, cwds } = opts;

    /** Track OAuth nonces for paste completion. */
    const pendingOAuthNonces = new Map<string, { session: ScenarioSession; serverName: string }>();

    function jsonResponse(data: unknown, status = 200): Response {
        return new Response(JSON.stringify(data, null, 2), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    }

    function errorResponse(message: string, status = 400): Response {
        return jsonResponse({ error: message }, status);
    }

    function htmlResponse(html: string, status = 200): Response {
        return new Response(html, {
            status,
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    }

    function getSession(index: number): ScenarioSession | null {
        return scenario.sessions[index - 1] ?? null;
    }

    const scenarioNames = Object.keys(scenarios);
    let apiBaseUrl = "";

    function buildOpenApiSpec() {
        return {
            openapi: "3.1.0",
            info: {
                title: "PizzaPi Sandbox Control API",
                version: "1.0.0",
                description: "Programmatic control surface for the PizzaPi sandbox harness.",
            },
            servers: apiBaseUrl ? [{ url: apiBaseUrl }] : [],
            paths: {
                "/status": { get: { summary: "List sessions and credentials", responses: { "200": { description: "OK" } } } },
                "/credentials": { get: { summary: "Get sandbox login credentials", responses: { "200": { description: "OK" } } } },
                "/session": { post: { summary: "Create a session", requestBody: { required: false }, responses: { "200": { description: "Created" } } } },
                "/chat": { post: { summary: "Stream a named chat scenario into a session", requestBody: { required: true }, responses: { "200": { description: "OK" } } } },
                "/oauth": { post: { summary: "Emit MCP OAuth paste flow for a session", requestBody: { required: true }, responses: { "200": { description: "OK" } } } },
                "/child": { post: { summary: "Create a child session", requestBody: { required: true }, responses: { "200": { description: "Created" } } } },
                "/end": { post: { summary: "End a session", requestBody: { required: true }, responses: { "200": { description: "OK" } } } },
                "/heartbeat": { post: { summary: "Send heartbeat to a session", requestBody: { required: true }, responses: { "200": { description: "OK" } } } },
                "/event": { post: { summary: "Emit an arbitrary relay event", requestBody: { required: true }, responses: { "200": { description: "OK" } } } },
            },
            "x-scenarios": scenarioNames,
        };
    }

    function buildIndexHtml() {
        const endpoints = [
            ["GET", "/status", "List sessions and credentials"],
            ["GET", "/credentials", "Get sandbox login credentials"],
            ["POST", "/session", "Create a session"],
            ["POST", "/chat", "Stream a named scenario into a session"],
            ["POST", "/oauth", "Trigger MCP OAuth paste flow"],
            ["POST", "/child", "Create a child session"],
            ["POST", "/end", "End a session"],
            ["POST", "/heartbeat", "Send heartbeat"],
            ["POST", "/event", "Emit arbitrary event"],
        ];
        const sessionItems = scenario.sessions.map((s, i) => `<li><code>${i + 1}</code> — <code>${s.sessionId}</code></li>`).join("");
        const endpointRows = endpoints.map(([m, p, d]) => `<tr><td><code>${m}</code></td><td><code>${p}</code></td><td>${d}</td></tr>`).join("");
        return `<!doctype html>
<html><head><meta charset="utf-8" /><title>PizzaPi Sandbox API</title>
<style>
body{font-family:system-ui,sans-serif;max-width:980px;margin:40px auto;padding:0 16px;line-height:1.45}
code{background:#f4f4f5;padding:2px 4px;border-radius:4px}
pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow:auto}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #e4e4e7;padding:8px;text-align:left}
.small{color:#52525b}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.card{border:1px solid #e4e4e7;border-radius:10px;padding:16px}
</style></head><body>
<h1>🍕 PizzaPi Sandbox Control API</h1>
<p class="small">Use this API to drive the sandbox without the REPL.</p>
<div class="grid">
  <div class="card"><h2>Base URLs</h2><ul>
    <li>Sandbox API: <a href="${apiBaseUrl}">${apiBaseUrl}</a></li>
    <li>PizzaPi server: <code>${scenario.server.baseUrl}</code></li>
    <li>OpenAPI: <a href="/openapi.json">/openapi.json</a></li>
  </ul></div>
  <div class="card"><h2>Credentials</h2><pre>${JSON.stringify({ email: scenario.server.userEmail, password: "HarnessPass123", apiKey: scenario.server.apiKey }, null, 2)}</pre></div>
</div>
<div class="card"><h2>Scenarios</h2><p>${scenarioNames.map((s) => `<code>${s}</code>`).join(" ")}</p></div>
<div class="card"><h2>Sessions</h2><ul>${sessionItems || "<li>None</li>"}</ul></div>
<div class="card"><h2>Endpoints</h2><table><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody>${endpointRows}</tbody></table></div>
<div class="card"><h2>Quick examples</h2><pre>curl ${apiBaseUrl}/status
curl -X POST ${apiBaseUrl}/oauth -H 'Content-Type: application/json' -d '{"session":1,"server":"figma"}'
curl -X POST ${apiBaseUrl}/chat -H 'Content-Type: application/json' -d '{"session":1,"scenario":"review"}'</pre></div>
</body></html>`;
    }

    const server = Bun.serve({
        port: opts.port ?? 0,
        hostname: "127.0.0.1",

        async fetch(req) {
            const url = new URL(req.url);
            const path = url.pathname;
            const method = req.method;

            // ── GET / ───────────────────────────────────────────────────
            if (method === "GET" && path === "/") {
                return htmlResponse(buildIndexHtml());
            }

            // ── GET /openapi.json ───────────────────────────────────────
            if (method === "GET" && path === "/openapi.json") {
                return jsonResponse(buildOpenApiSpec());
            }

            // ── GET /status ──────────────────────────────────────────────
            if (method === "GET" && path === "/status") {
                const sessions = scenario.sessions.map((s, i) => ({
                    index: i + 1,
                    sessionId: s.sessionId,
                    shareUrl: s.shareUrl,
                }));
                return jsonResponse({
                    sessions,
                    serverUrl: scenario.server.baseUrl,
                    credentials: {
                        email: scenario.server.userEmail,
                        password: "HarnessPass123",
                        apiKey: scenario.server.apiKey,
                    },
                });
            }

            // ── GET /credentials ─────────────────────────────────────────
            if (method === "GET" && path === "/credentials") {
                return jsonResponse({
                    email: scenario.server.userEmail,
                    password: "HarnessPass123",
                    apiKey: scenario.server.apiKey,
                    serverUrl: scenario.server.baseUrl,
                });
            }

            // ── POST /session ────────────────────────────────────────────
            if (method === "POST" && path === "/session") {
                const body = await req.json().catch(() => ({})) as Record<string, unknown>;
                const name = typeof body.name === "string" ? body.name : `session-${++sessionCounter}`;
                const model = models.find((m) => m.id === body.model) ?? pickRandom(models);
                const cwd = typeof body.cwd === "string" ? body.cwd : pickRandom(cwds);

                const sess = await scenario.addSession({ cwd, collabMode: true });
                sess.relay.emitEvent(sess.sessionId, sess.token, buildHeartbeat({
                    active: true,
                    sessionName: name,
                    model,
                    cwd,
                }), 0);

                return jsonResponse({
                    index: scenario.sessions.length,
                    sessionId: sess.sessionId,
                    shareUrl: sess.shareUrl,
                    name,
                    model: model.name,
                });
            }

            // ── POST /chat ───────────────────────────────────────────────
            if (method === "POST" && path === "/chat") {
                const body = await req.json().catch(() => ({})) as Record<string, unknown>;
                const idx = typeof body.session === "number" ? body.session : 1;
                const scenarioName = typeof body.scenario === "string" ? body.scenario : pickRandom(Object.keys(scenarios));

                const sess = getSession(idx);
                if (!sess) return errorResponse(`No session at index ${idx}`, 404);

                const chosen = scenarios[scenarioName];
                if (!chosen) return errorResponse(`Unknown scenario: ${scenarioName}. Options: ${Object.keys(scenarios).join(", ")}`);

                const events = chosen.builder();
                for (let i = 0; i < events.length; i++) {
                    sess.relay.emitEvent(sess.sessionId, sess.token, events[i], i + 100);
                    await sleep(80);
                }

                return jsonResponse({
                    session: idx,
                    scenario: scenarioName,
                    eventsStreamed: events.length,
                });
            }

            // ── POST /oauth ──────────────────────────────────────────────
            if (method === "POST" && path === "/oauth") {
                const body = await req.json().catch(() => ({})) as Record<string, unknown>;
                const idx = typeof body.session === "number" ? body.session : 1;
                const serverName = typeof body.server === "string" ? body.server : "figma";

                const sess = getSession(idx);
                if (!sess) return errorResponse(`No session at index ${idx}`, 404);

                const nonce = Math.random().toString(36).slice(2, 18);
                const authUrl = `https://www.figma.com/oauth?client_id=mock123&redirect_uri=${encodeURIComponent("http://localhost:1/callback")}&scope=mcp%3Aconnect&state=mock_state&response_type=code`;

                // Emit the paste-required event
                sess.relay.emitEvent(sess.sessionId, sess.token, {
                    type: "mcp_auth_paste_required",
                    serverName,
                    authUrl,
                    nonce,
                    ts: Date.now(),
                });

                // Track the nonce so we can auto-complete on paste
                pendingOAuthNonces.set(nonce, { session: sess, serverName });

                // Listen for the paste response on the relay socket
                sess.relay.socket.on("mcp_oauth_paste" as any, (data: any) => {
                    if (data?.nonce === nonce) {
                        // Complete the flow
                        sess.relay.emitEvent(sess.sessionId, sess.token, {
                            type: "mcp_auth_complete",
                            serverName,
                            ts: Date.now(),
                        });
                        pendingOAuthNonces.delete(nonce);
                    }
                });

                return jsonResponse({
                    session: idx,
                    serverName,
                    nonce,
                    authUrl,
                    message: "OAuth paste prompt emitted. Paste a URL in the web UI to complete.",
                });
            }

            // ── POST /child ──────────────────────────────────────────────
            if (method === "POST" && path === "/child") {
                const body = await req.json().catch(() => ({})) as Record<string, unknown>;
                const parentIdx = typeof body.parent === "number" ? body.parent : 1;

                const parent = getSession(parentIdx);
                if (!parent) return errorResponse(`No session at index ${parentIdx}`, 404);

                const model = pickRandom(models);
                const child = await scenario.addSession({
                    cwd: pickRandom(cwds),
                    collabMode: true,
                    parentSessionId: parent.sessionId,
                });

                child.relay.emitEvent(child.sessionId, child.token, buildHeartbeat({
                    active: true,
                    sessionName: `subagent-${++sessionCounter}`,
                    model,
                }), 0);

                return jsonResponse({
                    index: scenario.sessions.length,
                    sessionId: child.sessionId,
                    shareUrl: child.shareUrl,
                    parentIndex: parentIdx,
                    model: model.name,
                });
            }

            // ── POST /end ────────────────────────────────────────────────
            if (method === "POST" && path === "/end") {
                const body = await req.json().catch(() => ({})) as Record<string, unknown>;
                const idx = typeof body.session === "number" ? body.session : 1;

                const sess = getSession(idx);
                if (!sess) return errorResponse(`No session at index ${idx}`, 404);

                sess.relay.emitSessionEnd(sess.sessionId, sess.token);
                return jsonResponse({ session: idx, ended: true });
            }

            // ── POST /heartbeat ──────────────────────────────────────────
            if (method === "POST" && path === "/heartbeat") {
                const body = await req.json().catch(() => ({})) as Record<string, unknown>;
                const idx = typeof body.session === "number" ? body.session : 1;
                const active = body.active !== false;

                const sess = getSession(idx);
                if (!sess) return errorResponse(`No session at index ${idx}`, 404);

                sess.relay.emitEvent(sess.sessionId, sess.token, buildHeartbeat({ active }), Date.now());
                return jsonResponse({ session: idx, active });
            }

            // ── POST /event — emit arbitrary event ───────────────────────
            if (method === "POST" && path === "/event") {
                const body = await req.json().catch(() => ({})) as Record<string, unknown>;
                const idx = typeof body.session === "number" ? body.session : 1;
                const event = body.event;

                const sess = getSession(idx);
                if (!sess) return errorResponse(`No session at index ${idx}`, 404);
                if (!event || typeof event !== "object") return errorResponse("Missing 'event' object in body");

                sess.relay.emitEvent(sess.sessionId, sess.token, event);
                return jsonResponse({ session: idx, emitted: true });
            }

            return errorResponse("Not found", 404);
        },
    });

    const resolvedPort = server.port ?? 0;
    apiBaseUrl = `http://127.0.0.1:${resolvedPort}`;
    return {
        baseUrl: apiBaseUrl,
        port: resolvedPort,
        stop: () => server.stop(true),
    };
}
