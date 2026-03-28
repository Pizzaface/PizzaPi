/**
 * Tunnel tools extension — provides agent-facing tools to manage HTTP tunnels
 * through the PizzaPi relay server.
 *
 * Tools:
 *   create_tunnel — Expose a local port through the relay tunnel
 *   list_tunnels  — List currently active tunnels
 *   close_tunnel  — Close an active tunnel
 *
 * Communication: These tools send `service_message` envelopes on the agent's
 * relay Socket.IO connection. The relay namespace forwards them to the runner
 * daemon's TunnelService, which handles the actual port exposure. Responses
 * come back via `service_message` events with matching `requestId`.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { getRelaySocket as getRelaySocketDefault, getRelaySessionId as getRelaySessionIdDefault } from "./remote.js";
import { loadConfig as loadConfigDefault } from "../config.js";

/** Timeout for service_message request/response round-trips. */
const SERVICE_TIMEOUT_MS = 10_000;

interface TunnelInfo {
    port: number;
    name?: string;
    url: string;
    pinned?: boolean;
}

interface TunnelToolsDeps {
    getRelaySocket: typeof getRelaySocketDefault;
    getRelaySessionId: typeof getRelaySessionIdDefault;
    loadConfig: typeof loadConfigDefault;
    getRunnerId: () => string | null;
}

function getRunnerIdDefault(): string | null {
    const statePath = process.env.PIZZAPI_RUNNER_STATE_PATH ?? join(homedir(), ".pizzapi", "runner.json");
    try {
        if (!existsSync(statePath)) return null;
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        return typeof state.runnerId === "string" ? state.runnerId : null;
    } catch {
        return null;
    }
}

const defaultDeps: TunnelToolsDeps = {
    getRelaySocket: getRelaySocketDefault,
    getRelaySessionId: getRelaySessionIdDefault,
    loadConfig: loadConfigDefault,
    getRunnerId: getRunnerIdDefault,
};

/** Minimal Component that renders nothing — keeps the tool call invisible in the TUI. */
const silent = { render: (_width: number): string[] => [], invalidate: () => {} };

/**
 * Send a service_message to the daemon's TunnelService via the relay socket
 * and wait for a response with matching requestId.
 */
function sendTunnelServiceMessage(
    deps: TunnelToolsDeps,
    type: string,
    payload: unknown,
): Promise<{ type: string; payload: unknown }> {
    return new Promise((resolve, reject) => {
        const conn = deps.getRelaySocket();
        if (!conn) {
            reject(new Error("Not connected to relay. Cannot manage tunnels without a relay connection."));
            return;
        }

        const requestId = randomUUID();
        const { socket } = conn;
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.off("service_message" as any, handler);
            reject(new Error("Tunnel service request timed out (10s). Is the runner daemon running?"));
        }, SERVICE_TIMEOUT_MS);

        const handler = (envelope: { serviceId: string; type: string; requestId?: string; payload: unknown }) => {
            if (envelope.serviceId !== "tunnel") return;
            if (envelope.requestId !== requestId) return;
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.off("service_message" as any, handler);
            resolve({ type: envelope.type, payload: envelope.payload });
        };

        socket.on("service_message" as any, handler);
        socket.emit("service_message" as any, {
            serviceId: "tunnel",
            type,
            requestId,
            payload,
        });
    });
}

function getRelayHttpBaseUrl(deps: TunnelToolsDeps): string | null {
    const configured =
        process.env.PIZZAPI_RELAY_URL ??
        deps.loadConfig(process.cwd()).relayUrl ??
        "ws://localhost:7492";

    if (configured.toLowerCase() === "off") return null;

    const trimmed = configured.trim().replace(/\/$/, "").replace(/\/ws\/sessions$/, "");
    if (trimmed.startsWith("ws://")) return `http://${trimmed.slice("ws://".length)}`;
    if (trimmed.startsWith("wss://")) return `https://${trimmed.slice("wss://".length)}`;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
    return `https://${trimmed}`;
}

/**
 * Build the public tunnel URL. Prefers runner-based URLs (stable across session
 * switches) and falls back to session-based URLs if runner ID is unavailable.
 */
function buildPublicTunnelUrl(deps: TunnelToolsDeps, port: number): string | null {
    const base = getRelayHttpBaseUrl(deps);
    if (!base) return null;

    // Prefer runner-based URL — stable across session switches.
    const runnerId = deps.getRunnerId();
    if (runnerId) {
        return `${base}/api/tunnel/runner/${encodeURIComponent(runnerId)}/${port}/`;
    }

    // Fall back to session-based URL.
    const sessionId = deps.getRelaySessionId();
    if (!sessionId) return null;
    return `${base}/api/tunnel/${encodeURIComponent(sessionId)}/${port}/`;
}

function ok(text: string, details?: Record<string, unknown>) {
    return {
        content: [{ type: "text" as const, text }],
        details: details as any,
    };
}

export function createTunnelToolsExtension(deps: TunnelToolsDeps = defaultDeps): ExtensionFactory {
    return (pi) => {
    // ── create_tunnel ────────────────────────────────────────────────────────
    pi.registerTool({
        name: "create_tunnel",
        label: "Create Tunnel",
        description:
            "Expose a local port through the PizzaPi relay server so it's accessible " +
            "from the web UI. Use this after starting a local dev server to make it " +
            "accessible remotely. Returns the public URL for the tunnel.",
        parameters: {
            type: "object",
            properties: {
                port: {
                    type: "number",
                    description: "Local port to expose (1–65535).",
                },
                name: {
                    type: "string",
                    description: "Optional human-readable name for the tunnel (e.g. 'dev-server', 'storybook').",
                },
            },
            required: ["port"],
        } as any,

        async execute(_toolCallId, rawParams) {
            const params = (rawParams ?? {}) as { port: number; name?: string };
            const port = params.port;

            if (!port || !Number.isFinite(port) || port < 1 || port > 65535) {
                return ok("Error: port must be a number between 1 and 65535.", { error: "Invalid port" });
            }

            try {
                const response = await sendTunnelServiceMessage(deps, "tunnel_expose", {
                    port,
                    name: params.name ?? undefined,
                });

                if (response.type === "tunnel_error") {
                    const error = (response.payload as { error?: string })?.error ?? "Unknown tunnel error";
                    return ok(`Error creating tunnel: ${error}`, { error });
                }

                if (response.type === "tunnel_registered") {
                    const info = response.payload as TunnelInfo;
                    const publicUrl = buildPublicTunnelUrl(deps, info.port);

                    const lines = [
                        `Tunnel created successfully.`,
                        `  Port: ${info.port}`,
                        info.name ? `  Name: ${info.name}` : null,
                        publicUrl ? `  Public URL: ${publicUrl}` : `  URL: ${info.url}`,
                    ].filter(Boolean).join("\n");

                    return ok(lines, {
                        port: info.port,
                        name: info.name ?? null,
                        url: info.url,
                        publicUrl: publicUrl ?? null,
                    });
                }

                return ok(`Unexpected response from tunnel service: ${response.type}`, {
                    error: `Unexpected type: ${response.type}`,
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return ok(`Error: ${message}`, { error: message });
            }
        },

        renderCall: (args: any, theme: any) => {
            const port = args.port ?? "?";
            const name = args.name ? ` (${args.name})` : "";
            return new Text(
                theme.fg("accent", "⇡") + " " +
                theme.fg("muted", "creating tunnel") +
                theme.fg("dim", ` :${port}${name}`),
                0, 0,
            );
        },
        renderResult: (result: any, _opts: any, theme: any) => {
            const details = result?.details as Record<string, unknown> | undefined;
            const text: string = result?.content?.[0]?.text ?? "";

            if (details?.error || text.startsWith("Error")) {
                const msg = typeof details?.error === "string" ? details.error : text;
                return new Text(theme.fg("error", "✗ " + (msg.length > 80 ? msg.slice(0, 77) + "..." : msg)), 0, 0);
            }

            const port = details?.port ?? "?";
            const url = typeof details?.publicUrl === "string" ? ` ${details.publicUrl}` : "";
            return new Text(
                theme.fg("success", "✓") + " " +
                theme.fg("muted", "tunnel :") +
                theme.fg("accent", String(port)) +
                theme.fg("dim", url),
                0, 0,
            );
        },
    });

    // ── list_tunnels ─────────────────────────────────────────────────────────
    pi.registerTool({
        name: "list_tunnels",
        label: "List Tunnels",
        description:
            "List all currently active tunnels for this session. Returns each tunnel's " +
            "port, name, and public URL.",
        parameters: {
            type: "object",
            properties: {},
        } as any,

        async execute() {
            try {
                const response = await sendTunnelServiceMessage(deps, "tunnel_list", {});

                if (response.type === "tunnel_list_result") {
                    const tunnels = ((response.payload as { tunnels?: TunnelInfo[] })?.tunnels ?? [])
                        .map((t) => ({
                            port: t.port,
                            name: t.name ?? null,
                            url: t.url,
                            publicUrl: buildPublicTunnelUrl(deps, t.port) ?? null,
                            pinned: t.pinned ?? false,
                        }));

                    if (tunnels.length === 0) {
                        return ok("No active tunnels.", { tunnels: [] });
                    }

                    const lines = [
                        `${tunnels.length} active tunnel(s):`,
                        ...tunnels.map((t) => {
                            const name = t.name ? ` (${t.name})` : "";
                            const pinned = t.pinned ? " [pinned]" : "";
                            const url = t.publicUrl ?? t.url;
                            return `  :${t.port}${name}${pinned} → ${url}`;
                        }),
                    ];

                    return ok(lines.join("\n"), { tunnels });
                }

                return ok(`Unexpected response: ${response.type}`, { error: `Unexpected type: ${response.type}` });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return ok(`Error: ${message}`, { error: message });
            }
        },

        renderCall: (_args: any, theme: any) => {
            return new Text(
                theme.fg("accent", "⇡") + " " +
                theme.fg("muted", "listing tunnels"),
                0, 0,
            );
        },
        renderResult: (result: any, _opts: any, theme: any) => {
            const details = result?.details as Record<string, unknown> | undefined;
            const text: string = result?.content?.[0]?.text ?? "";

            if (details?.error || text.startsWith("Error")) {
                const msg = typeof details?.error === "string" ? details.error : text;
                return new Text(theme.fg("error", "✗ " + msg), 0, 0);
            }

            const tunnels = (details?.tunnels as any[]) ?? [];
            return new Text(
                theme.fg("success", "✓") + " " +
                theme.fg("muted", `${tunnels.length} tunnel(s)`),
                0, 0,
            );
        },
    });

    // ── close_tunnel ─────────────────────────────────────────────────────────
    pi.registerTool({
        name: "close_tunnel",
        label: "Close Tunnel",
        description:
            "Close an active tunnel by port number. Stops proxying traffic to the " +
            "specified local port.",
        parameters: {
            type: "object",
            properties: {
                port: {
                    type: "number",
                    description: "Port of the tunnel to close.",
                },
            },
            required: ["port"],
        } as any,

        async execute(_toolCallId, rawParams) {
            const params = (rawParams ?? {}) as { port: number };
            const port = params.port;

            if (!port || !Number.isFinite(port) || port < 1 || port > 65535) {
                return ok("Error: port must be a number between 1 and 65535.", { error: "Invalid port" });
            }

            try {
                // The tunnel service emits tunnel_removed on success (fire-and-forget).
                // We listen for it briefly, but also accept that the operation may
                // succeed silently if the port wasn't tracked.
                const conn = deps.getRelaySocket();
                if (!conn) {
                    return ok("Error: Not connected to relay.", { error: "Not connected" });
                }

                const requestId = randomUUID();
                const { socket } = conn;

                // Set up a brief listener for the tunnel_removed response
                const result = await new Promise<{ closed: boolean }>((resolve) => {
                    let settled = false;

                    const timer = setTimeout(() => {
                        if (settled) return;
                        settled = true;
                        socket.off("service_message" as any, handler);
                        // If we time out, the unexpose likely succeeded anyway
                        // (it's fire-and-forget on the daemon side for unknown ports).
                        resolve({ closed: true });
                    }, SERVICE_TIMEOUT_MS);

                    const handler = (envelope: { serviceId: string; type: string; requestId?: string; payload: unknown }) => {
                        if (envelope.serviceId !== "tunnel") return;
                        // tunnel_removed doesn't echo requestId, match by port
                        if (envelope.type === "tunnel_removed") {
                            const removedPort = (envelope.payload as { port?: number })?.port;
                            if (removedPort === port) {
                                if (settled) return;
                                settled = true;
                                clearTimeout(timer);
                                socket.off("service_message" as any, handler);
                                resolve({ closed: true });
                            }
                        }
                    };

                    socket.on("service_message" as any, handler);
                    socket.emit("service_message" as any, {
                        serviceId: "tunnel",
                        type: "tunnel_unexpose",
                        requestId,
                        payload: { port },
                    });
                });

                return ok(
                    result.closed ? `Tunnel on port ${port} closed.` : `Port ${port} was not tunneled.`,
                    { closed: result.closed, port },
                );
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return ok(`Error: ${message}`, { error: message });
            }
        },

        renderCall: (args: any, theme: any) => {
            const port = args.port ?? "?";
            return new Text(
                theme.fg("accent", "⇣") + " " +
                theme.fg("muted", "closing tunnel") +
                theme.fg("dim", ` :${port}`),
                0, 0,
            );
        },
        renderResult: (result: any, _opts: any, theme: any) => {
            const details = result?.details as Record<string, unknown> | undefined;
            const text: string = result?.content?.[0]?.text ?? "";

            if (details?.error || text.startsWith("Error")) {
                const msg = typeof details?.error === "string" ? details.error : text;
                return new Text(theme.fg("error", "✗ " + msg), 0, 0);
            }

            const port = details?.port ?? "?";
            return new Text(
                theme.fg("success", "✓") + " " +
                theme.fg("muted", "closed :") +
                theme.fg("accent", String(port)),
                0, 0,
            );
        },
    });
    };
}

export const tunnelToolsExtension: ExtensionFactory = createTunnelToolsExtension();
