import { buildSessionContext, type ExtensionContext, type ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config.js";

interface RelayState {
    ws: WebSocket;
    sessionId: string;
    token: string;
    shareUrl: string;
}

const RELAY_DEFAULT = "ws://localhost:3001";
const RECONNECT_MAX_DELAY = 30_000;

/**
 * PizzaPi Remote extension.
 *
 * Automatically connects to the PizzaPi relay on session start and streams all
 * agent events in real-time so any browser client can pick up the session.
 *
 * Config:
 *   PIZZAPI_RELAY_URL  WebSocket URL of the relay (default: ws://localhost:3000)
 *                      Set to "off" to disable auto-connect.
 *
 * Commands:
 *   /remote            Show the current share URL (or "not connected")
 *   /remote stop       Disconnect from relay
 *   /remote reconnect  Force reconnect
 */
export const remoteExtension: ExtensionFactory = (pi) => {
    let relay: RelayState | null = null;
    let reconnectDelay = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shuttingDown = false;
    let latestCtx: ExtensionContext | null = null;

    // ── Core relay helpers ────────────────────────────────────────────────────

    function relayUrl(): string {
        const configured =
            process.env.PIZZAPI_RELAY_URL ??
            loadConfig(process.cwd()).relayUrl ??
            RELAY_DEFAULT;
        return configured.replace(/\/$/, "");
    }

    function toWebSocketBaseUrl(value: string): string {
        const trimmed = value.trim().replace(/\/$/, "");
        if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
            return trimmed;
        }
        if (trimmed.startsWith("http://")) {
            return `ws://${trimmed.slice("http://".length)}`;
        }
        if (trimmed.startsWith("https://")) {
            return `wss://${trimmed.slice("https://".length)}`;
        }
        return trimmed;
    }

    function isDisabled(): boolean {
        const configured = process.env.PIZZAPI_RELAY_URL ?? loadConfig(process.cwd()).relayUrl ?? "";
        return configured.toLowerCase() === "off";
    }

    function send(payload: unknown) {
        if (!relay || relay.ws.readyState !== WebSocket.OPEN) return;
        relay.ws.send(JSON.stringify(payload));
    }

    function forwardEvent(event: unknown) {
        if (!relay) return;
        send({ type: "event", sessionId: relay.sessionId, token: relay.token, event });
    }

    function buildSessionState() {
        if (!latestCtx) return undefined;
        const { messages, model, thinkingLevel } = buildSessionContext(
            latestCtx.sessionManager.getEntries(),
            latestCtx.sessionManager.getLeafId(),
        );
        return { messages, model, thinkingLevel, cwd: latestCtx.cwd };
    }

    function scheduleReconnect(notify?: (msg: string) => void) {
        if (shuttingDown || isDisabled()) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect(notify);
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
    }

    // ── WebSocket connection ──────────────────────────────────────────────────

    function apiKey(): string | undefined {
        return process.env.PIZZAPI_API_KEY ?? loadConfig(process.cwd()).apiKey;
    }

    function connect(notify?: (msg: string) => void) {
        if (isDisabled() || shuttingDown) return;

        const key = apiKey();
        if (!key) {
            const msg =
                "PizzaPi: no API key configured. Set PIZZAPI_API_KEY or add \"apiKey\" to .pizzapi/config.json. Remote sharing disabled.";
            console.warn(msg);
            notify?.(msg);
            return;
        }

        const wsBase = toWebSocketBaseUrl(relayUrl());
        const wsPath = wsBase.endsWith("/ws/sessions") ? wsBase : `${wsBase}/ws/sessions`;
        const wsUrl = `${wsPath}?apiKey=${encodeURIComponent(key)}`;

        let ws: WebSocket;
        try {
            ws = new WebSocket(wsUrl, { headers: { "x-api-key": key } } as any);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const text = `PizzaPi: failed to connect to relay (${wsUrl}): ${message}`;
            console.warn(text);
            notify?.(text);
            scheduleReconnect(notify);
            return;
        }

        ws.onopen = () => {
            reconnectDelay = 1000; // reset backoff on success
            ws.send(JSON.stringify({ type: "register", cwd: process.cwd() }));
        };

        ws.onmessage = (evt) => {
            let msg: Record<string, unknown>;
            try {
                msg = JSON.parse(evt.data as string);
            } catch {
                return;
            }

            if (msg.type === "registered") {
                relay = {
                    ws,
                    sessionId: msg.sessionId as string,
                    token: msg.token as string,
                    shareUrl: msg.shareUrl as string,
                };

                forwardEvent({ type: "session_active", state: buildSessionState() });

                // Switch to steady-state message handler (collab input)
                ws.onmessage = (inputEvt) => {
                    let inputMsg: Record<string, unknown>;
                    try {
                        inputMsg = JSON.parse(inputEvt.data as string);
                    } catch {
                        return;
                    }
                    if (inputMsg.type === "input" && typeof inputMsg.text === "string") {
                        pi.sendUserMessage(inputMsg.text);
                    }
                };
            }
        };

        ws.onerror = () => {
            // close will fire next and handle reconnect
        };

        ws.onclose = (event) => {
            if (relay?.ws === ws) relay = null;
            if (!shuttingDown) {
                console.warn(
                    `PizzaPi: relay disconnected (code=${event.code}, reason=${event.reason || "none"}). Reconnecting…`
                );
            }
            if (!shuttingDown) scheduleReconnect(notify);
        };
    }

    function disconnect() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (relay) {
            send({ type: "session_end", sessionId: relay.sessionId, token: relay.token });
            relay.ws.close();
            relay = null;
        }
    }

    // ── Auto-connect on session start ─────────────────────────────────────────

    pi.on("session_start", (_event, ctx) => {
        latestCtx = ctx;
        if (isDisabled()) return;
        connect();
    });

    pi.on("session_switch", (_event, ctx) => {
        latestCtx = ctx;
        forwardEvent({ type: "session_active", state: buildSessionState() });
    });

    pi.on("session_shutdown", () => {
        shuttingDown = true;
        disconnect();
    });

    // ── /remote command ───────────────────────────────────────────────────────

    pi.registerCommand("remote", {
        description: "Show hub share URL, or: /remote stop | /remote reconnect",
        handler: async (args, ctx) => {
            const arg = args.trim().toLowerCase();

            if (arg === "stop") {
                disconnect();
                ctx.ui.notify("Disconnected from hub.");
                return;
            }

            if (arg === "reconnect") {
                disconnect();
                shuttingDown = false;
                reconnectDelay = 1000;
                connect((msg) => ctx.ui.notify(msg));
                ctx.ui.notify("Reconnecting to hub…");
                return;
            }

            // Default: show status
            if (relay) {
                ctx.ui.notify(`Hub connected\nShare URL: ${relay.shareUrl}`);
            } else {
                const url = isDisabled() ? "(disabled — set PIZZAPI_RELAY_URL to enable)" : relayUrl();
                ctx.ui.notify(`Not connected to hub.\nRelay: ${url}\nUse /remote reconnect to retry.`);
            }
        },
    });

    // ── Forward agent events to relay ─────────────────────────────────────────

    pi.on("agent_start", (event) => forwardEvent(event));
    pi.on("agent_end", (event) => forwardEvent(event));
    pi.on("turn_start", (event) => forwardEvent(event));
    pi.on("turn_end", (event) => forwardEvent(event));
    pi.on("message_start", (event) => forwardEvent(event));
    pi.on("message_update", (event) => forwardEvent(event));
    pi.on("message_end", (event) => forwardEvent(event));
    pi.on("tool_execution_start", (event) => forwardEvent(event));
    pi.on("tool_execution_update", (event) => forwardEvent(event));
    pi.on("tool_execution_end", (event) => forwardEvent(event));
};
