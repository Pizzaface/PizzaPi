import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config.js";

const silent = { render: (_width: number): string[] => [], invalidate: () => {} };

/**
 * Provides a tool to check the status of a session by its ID.
 */
export const getSessionStatusExtension: ExtensionFactory = (pi) => {
    function getRelayHttpBaseUrl(): string | null {
        const configured =
            process.env.PIZZAPI_RELAY_URL ??
            loadConfig(process.cwd()).relayUrl ??
            "ws://localhost:3001";

        if (configured.toLowerCase() === "off") return null;

        const trimmed = configured.trim().replace(/\/$/, "").replace(/\/ws\/sessions$/, "");
        if (trimmed.startsWith("ws://")) return `http://${trimmed.slice("ws://".length)}`;
        if (trimmed.startsWith("wss://")) return `https://${trimmed.slice("wss://".length)}`;
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
        return trimmed;
    }

    function getApiKey(): string | undefined {
        return process.env.PIZZAPI_API_KEY ?? loadConfig(process.cwd()).apiKey;
    }

    pi.registerTool({
        name: "get_session_status",
        label: "Get Session Status",
        description:
            "Check the status of a session by its ID. Returns whether the session is active, " +
            "its name, working directory, model, and other metadata. Useful for monitoring " +
            "spawned sessions.",
        parameters: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "The session ID to check.",
                },
            },
            required: ["sessionId"],
        } as any,

        async execute(_toolCallId, rawParams) {
            const params = (rawParams ?? {}) as { sessionId: string };

            const ok = (text: string, details?: Record<string, unknown>) => ({
                content: [{ type: "text" as const, text }],
                details: details as any,
            });

            const sessionId = params.sessionId?.trim();
            if (!sessionId) {
                return ok("Error: sessionId is required.", { error: "Missing sessionId" });
            }

            const relayBase = getRelayHttpBaseUrl();
            if (!relayBase) {
                return ok("Error: Relay is disabled.", { error: "Relay disabled" });
            }

            const apiKey = getApiKey();
            if (!apiKey) {
                return ok("Error: No API key configured.", { error: "No API key" });
            }

            try {
                const response = await fetch(
                    `${relayBase}/api/sessions/${encodeURIComponent(sessionId)}/status`,
                    {
                        method: "GET",
                        headers: { "x-api-key": apiKey },
                    },
                );

                const result = (await response.json()) as Record<string, unknown>;

                if (!response.ok) {
                    const errorMsg =
                        typeof result.error === "string" ? result.error : `HTTP ${response.status}`;
                    return ok(`Error: ${errorMsg}`, { error: errorMsg, status: response.status });
                }

                const lines = [
                    `Session: ${result.sessionId}`,
                    result.sessionName ? `  Name: ${result.sessionName}` : null,
                    `  Active: ${result.isActive ? "yes" : "no"}`,
                    result.cwd ? `  Working directory: ${result.cwd}` : null,
                    result.model ? `  Model: ${JSON.stringify(result.model)}` : null,
                    result.runnerId ? `  Runner: ${result.runnerId}` : null,
                    result.runnerName ? `  Runner name: ${result.runnerName}` : null,
                    result.startedAt ? `  Started: ${result.startedAt}` : null,
                    result.lastHeartbeatAt ? `  Last heartbeat: ${result.lastHeartbeatAt}` : null,
                    result.shareUrl ? `  URL: ${result.shareUrl}` : null,
                ].filter(Boolean).join("\n");

                return ok(lines, result);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return ok(`Error checking session status: ${message}`, { error: message });
            }
        },

        renderCall: () => silent,
        renderResult: () => silent,
    });
};
