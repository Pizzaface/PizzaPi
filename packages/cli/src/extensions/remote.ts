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
const RELAY_STATUS_KEY = "relay";

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

    function setRelayStatus(text?: string) {
        if (!latestCtx) return;
        latestCtx.ui.setStatus(RELAY_STATUS_KEY, text);
    }

    function sanitizeStatusText(text: string): string {
        return text
            .replace(/\x1B\[[0-9;]*m/g, "")
            .replace(/[\r\n\t]/g, " ")
            .replace(/ +/g, " ")
            .trim();
    }

    function formatTokens(count: number): string {
        if (count < 1000) return count.toString();
        if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
        if (count < 1000000) return `${Math.round(count / 1000)}k`;
        if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
        return `${Math.round(count / 1000000)}M`;
    }

    function truncateEnd(text: string, width: number): string {
        if (width <= 0) return "";
        if (text.length <= width) return text;
        if (width <= 3) return text.slice(0, width);
        return `${text.slice(0, width - 3)}...`;
    }

    function truncateMiddle(text: string, width: number): string {
        if (width <= 0) return "";
        if (text.length <= width) return text;
        if (width <= 5) return truncateEnd(text, width);
        const half = Math.floor((width - 3) / 2);
        const start = text.slice(0, half);
        const end = text.slice(-(width - 3 - half));
        return `${start}...${end}`;
    }

    function layoutLeftRight(
        left: string,
        right: string,
        width: number,
        truncateLeft: (text: string, width: number) => string,
    ): { left: string; pad: string; right: string } {
        if (width <= 0) return { left: "", pad: "", right: "" };
        const safeRight = truncateEnd(right, width);
        if (!safeRight) return { left: truncateLeft(left, width), pad: "", right: "" };
        if (safeRight.length + 2 >= width) return { left: "", pad: "", right: safeRight };

        const leftWidth = width - safeRight.length - 2;
        const safeLeft = truncateLeft(left, leftWidth);
        const pad = " ".repeat(Math.max(width - safeLeft.length - safeRight.length, 2));
        return { left: safeLeft, pad, right: safeRight };
    }

    function installFooter(ctx: ExtensionContext) {
        ctx.ui.setFooter((tui, theme, footerData) => {
            const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

            return {
                dispose: unsubscribe,
                invalidate() {},
                render(width: number): string[] {
                    const activeCtx = latestCtx ?? ctx;

                    let totalInput = 0;
                    let totalOutput = 0;
                    let totalCacheRead = 0;
                    let totalCacheWrite = 0;
                    let totalCost = 0;
                    for (const entry of activeCtx.sessionManager.getEntries()) {
                        if (entry.type === "message" && entry.message.role === "assistant") {
                            totalInput += entry.message.usage.input;
                            totalOutput += entry.message.usage.output;
                            totalCacheRead += entry.message.usage.cacheRead;
                            totalCacheWrite += entry.message.usage.cacheWrite;
                            totalCost += entry.message.usage.cost.total;
                        }
                    }

                    const contextUsage = activeCtx.getContextUsage();
                    const contextWindow = contextUsage?.contextWindow ?? activeCtx.model?.contextWindow ?? 0;
                    const contextPart =
                        contextUsage?.percent === null
                            ? `?/${formatTokens(contextWindow)} (auto)`
                            : `${(contextUsage?.percent ?? 0).toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;

                    let pwd = activeCtx.cwd;
                    const home = process.env.HOME || process.env.USERPROFILE;
                    if (home && pwd.startsWith(home)) {
                        pwd = `~${pwd.slice(home.length)}`;
                    }

                    const branch = footerData.getGitBranch();
                    if (branch) {
                        pwd = `${pwd} (${branch})`;
                    }

                    const sessionName = activeCtx.sessionManager.getSessionName();
                    if (sessionName) {
                        pwd = `${pwd} • ${sessionName}`;
                    }

                    const statsParts: string[] = [];
                    if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
                    if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
                    if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
                    if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
                    if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);
                    statsParts.push(contextPart);

                    const { thinkingLevel } = buildSessionContext(
                        activeCtx.sessionManager.getEntries(),
                        activeCtx.sessionManager.getLeafId(),
                    );
                    const modelName = activeCtx.model?.id ?? "no-model";
                    let modelText =
                        activeCtx.model?.reasoning && thinkingLevel
                            ? thinkingLevel === "off"
                                ? `${modelName} • thinking off`
                                : `${modelName} • ${thinkingLevel}`
                            : modelName;

                    if (footerData.getAvailableProviderCount() > 1 && activeCtx.model) {
                        modelText = `(${activeCtx.model.provider}) ${modelText}`;
                    }

                    const extensionStatuses = footerData.getExtensionStatuses();
                    const relayStatus = sanitizeStatusText(extensionStatuses.get(RELAY_STATUS_KEY) ?? "");

                    const statsText = statsParts.join(" ");
                    const modelBadge = `• ${modelText}`;
                    const locationLine = layoutLeftRight(pwd, modelBadge, width, truncateMiddle);
                    const statsLine = layoutLeftRight(statsText, relayStatus, width, truncateEnd);

                    return [
                        theme.fg("dim", locationLine.left) + locationLine.pad + theme.fg("dim", locationLine.right),
                        theme.fg("dim", statsLine.left) + statsLine.pad + theme.fg("success", statsLine.right),
                    ];
                },
            };
        });
    }

    function scheduleReconnect() {
        if (shuttingDown || isDisabled()) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
    }

    // ── WebSocket connection ──────────────────────────────────────────────────

    function apiKey(): string | undefined {
        return process.env.PIZZAPI_API_KEY ?? loadConfig(process.cwd()).apiKey;
    }

    function connect() {
        if (isDisabled() || shuttingDown) {
            setRelayStatus(undefined);
            return;
        }

        const key = apiKey();
        if (!key) {
            setRelayStatus(undefined);
            return;
        }

        const wsBase = toWebSocketBaseUrl(relayUrl());
        const wsPath = wsBase.endsWith("/ws/sessions") ? wsBase : `${wsBase}/ws/sessions`;
        const wsUrl = `${wsPath}?apiKey=${encodeURIComponent(key)}`;

        let ws: WebSocket;
        try {
            ws = new WebSocket(wsUrl, { headers: { "x-api-key": key } } as any);
        } catch {
            setRelayStatus(undefined);
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            reconnectDelay = 1000; // reset backoff on success
            ws.send(JSON.stringify({ type: "register", cwd: process.cwd(), collabMode: true }));
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
                setRelayStatus("Connected to Relay");

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

        ws.onclose = () => {
            if (relay?.ws === ws) relay = null;
            setRelayStatus(undefined);
            if (!shuttingDown) scheduleReconnect();
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
        setRelayStatus(undefined);
    }

    // ── Auto-connect on session start ─────────────────────────────────────────

    pi.on("session_start", (_event, ctx) => {
        latestCtx = ctx;
        installFooter(ctx);
        if (isDisabled()) {
            setRelayStatus(undefined);
            return;
        }
        connect();
    });

    pi.on("session_switch", (_event, ctx) => {
        latestCtx = ctx;
        installFooter(ctx);
        setRelayStatus(relay ? "Connected to Relay" : undefined);
        forwardEvent({ type: "session_active", state: buildSessionState() });
    });

    pi.on("session_shutdown", () => {
        shuttingDown = true;
        disconnect();
    });

    // ── /remote command ───────────────────────────────────────────────────────

    pi.registerCommand("remote", {
        description: "Show relay share URL, or: /remote stop | /remote reconnect",
        handler: async (args, ctx) => {
            const arg = args.trim().toLowerCase();

            if (arg === "stop") {
                disconnect();
                ctx.ui.notify("Disconnected from relay.");
                return;
            }

            if (arg === "reconnect") {
                disconnect();
                shuttingDown = false;
                reconnectDelay = 1000;
                connect();
                ctx.ui.notify("Reconnecting to relay…");
                return;
            }

            // Default: show status
            if (relay) {
                ctx.ui.notify(`Connected to Relay\nShare URL: ${relay.shareUrl}`);
            } else {
                const url = isDisabled() ? "(disabled — set PIZZAPI_RELAY_URL to enable)" : relayUrl();
                ctx.ui.notify(`Not connected to relay.\nRelay: ${url}\nUse /remote reconnect to retry.`);
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
