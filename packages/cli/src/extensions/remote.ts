import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

interface RelayState {
    ws: WebSocket;
    sessionId: string;
    token: string;
}

/**
 * PizzaPi Remote extension — registers `/liveshare` to stream the active session
 * to a browser via the PizzaPi relay server (packages/server).
 *
 * Usage:
 *   /liveshare         — start sharing, prints browser URL
 *   /liveshare stop    — disconnect
 */
export const remoteExtension: ExtensionFactory = (pi) => {
    let relay: RelayState | null = null;

    function send(payload: unknown) {
        if (!relay || relay.ws.readyState !== WebSocket.OPEN) return;
        relay.ws.send(JSON.stringify(payload));
    }

    function forwardEvent(event: unknown) {
        if (!relay) return;
        send({ type: "event", sessionId: relay.sessionId, token: relay.token, event });
    }

    // ── /liveshare command ────────────────────────────────────────────────────
    pi.registerCommand("liveshare", {
        description: "Stream this session live to a browser (pizzapi relay)",
        handler: async (args, ctx) => {
            const arg = args.trim().toLowerCase();

            if (arg === "stop") {
                if (!relay) {
                    ctx.ui.notify("No active live share session.");
                    return;
                }
                send({ type: "session_end", sessionId: relay.sessionId, token: relay.token });
                relay.ws.close();
                relay = null;
                ctx.ui.notify("Live share disconnected.");
                return;
            }

            if (relay) {
                ctx.ui.notify("Live share already active. Use /liveshare stop to disconnect.");
                return;
            }

            const relayBase = (process.env.PIZZAPI_RELAY_URL ?? "ws://localhost:3000").replace(/\/$/, "");
            const wsUrl = `${relayBase}/ws/sessions`;

            ctx.ui.notify(`Connecting to relay at ${wsUrl}…`);

            const ws = new WebSocket(wsUrl);

            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("Relay connection timed out")), 8000);

                ws.onopen = () => {
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
                        clearTimeout(timeout);
                        relay = { ws, sessionId: msg.sessionId as string, token: msg.token as string };
                        ctx.ui.notify(`Live share active!\nShare URL: ${msg.shareUrl}`);

                        // Handle collab-mode input from browser viewers
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

                        resolve();
                    } else if (msg.type === "error") {
                        clearTimeout(timeout);
                        reject(new Error((msg.message as string) ?? "Relay error"));
                    }
                };

                ws.onerror = () => {
                    clearTimeout(timeout);
                    reject(new Error("Could not connect to relay. Is PIZZAPI_RELAY_URL set correctly?"));
                };

                ws.onclose = () => {
                    relay = null;
                };
            }).catch((err: Error) => {
                ws.close();
                ctx.ui.notify(`Live share failed: ${err.message}`);
            });
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

    pi.on("session_shutdown", () => {
        if (!relay) return;
        send({ type: "session_end", sessionId: relay.sessionId, token: relay.token });
        relay.ws.close();
        relay = null;
    });
};
