import type { ExtensionContext, ExtensionFactory } from "@mariozechner/pi-coding-agent";

interface RelayState {
    ws: WebSocket;
    sessionId: string;
    token: string;
    shareUrl: string;
}

const RELAY_DEFAULT = "ws://localhost:3000";
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
 *   /share             Show the current share URL (or "not connected")
 *   /share stop        Disconnect from relay
 *   /share reconnect   Force reconnect
 */
export const remoteExtension: ExtensionFactory = (pi) => {
    let relay: RelayState | null = null;
    let reconnectDelay = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shuttingDown = false;

    // ── Core relay helpers ────────────────────────────────────────────────────

    function relayUrl(): string {
        return (process.env.PIZZAPI_RELAY_URL ?? RELAY_DEFAULT).replace(/\/$/, "");
    }

    function isDisabled(): boolean {
        return (process.env.PIZZAPI_RELAY_URL ?? "").toLowerCase() === "off";
    }

    function send(payload: unknown) {
        if (!relay || relay.ws.readyState !== WebSocket.OPEN) return;
        relay.ws.send(JSON.stringify(payload));
    }

    function forwardEvent(event: unknown) {
        if (!relay) return;
        send({ type: "event", sessionId: relay.sessionId, token: relay.token, event });
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

    function connect(notify?: (msg: string) => void) {
        if (isDisabled() || shuttingDown) return;

        const wsUrl = `${relayUrl()}/ws/sessions`;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            reconnectDelay = 1000; // reset backoff on success
            ws.send(JSON.stringify({ type: "register" }));
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
                notify?.(`Connected to hub — share URL: ${relay.shareUrl}`);

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

        ws.onclose = () => {
            if (relay?.ws === ws) relay = null;
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

    pi.on("session_start", (_event, ctx: ExtensionContext) => {
        if (isDisabled()) return;
        // Use ctx.ui.notify so the share URL appears in the TUI on startup
        connect((msg) => ctx.ui.notify(msg));
    });

    pi.on("session_shutdown", () => {
        shuttingDown = true;
        disconnect();
    });

    // ── /share command ────────────────────────────────────────────────────────

    pi.registerCommand("share", {
        description: "Show hub share URL, or: /share stop | /share reconnect",
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
                ctx.ui.notify(`Not connected to hub.\nRelay: ${url}\nUse /share reconnect to retry.`);
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
