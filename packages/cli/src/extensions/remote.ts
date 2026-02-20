import { buildSessionContext, type ExtensionContext, type ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../config.js";
import type { RemoteExecRequest, RemoteExecResponse } from "./remote-commands.js";

interface RelayState {
    ws: WebSocket;
    sessionId: string;
    token: string;
    shareUrl: string;
    /** Monotonic sequence number for the next event forwarded to relay */
    seq: number;
}

interface AskUserQuestionParams {
    question: string;
    placeholder?: string;
}

interface AskUserQuestionDetails {
    question: string;
    answer: string | null;
    source: "tui" | "web" | null;
    cancelled: boolean;
    status?: "waiting" | "answered";
}

interface PendingAskUserQuestion {
    toolCallId: string;
    question: string;
    resolve: (answer: string | null) => void;
}

interface RelayModelInfo {
    provider: string;
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
}

const RELAY_DEFAULT = "ws://localhost:3001";
const RECONNECT_MAX_DELAY = 30_000;
const RELAY_STATUS_KEY = "relay";
const ASK_USER_TOOL_NAME = "AskUserQuestion";

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
 *
 * Note: The `new_session` exec handler relies on a Bun patch applied to
 * `@mariozechner/pi-coding-agent` that exposes `newSession()` on the extension
 * runtime. See `patches/README.md` for details.
 */
export const remoteExtension: ExtensionFactory = (pi) => {
    let relay: RelayState | null = null;
    let reconnectDelay = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shuttingDown = false;
    let latestCtx: ExtensionContext | null = null;
    let pendingAskUserQuestion: PendingAskUserQuestion | null = null;

    // ── Heartbeat state ───────────────────────────────────────────────────────
    let isAgentActive = false;
    let sessionStartedAt: number | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
        const seq = ++relay.seq;
        send({ type: "event", sessionId: relay.sessionId, token: relay.token, event, seq });
    }

    function buildTokenUsage() {
        if (!latestCtx) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
        for (const entry of latestCtx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
                input += entry.message.usage.input;
                output += entry.message.usage.output;
                cacheRead += entry.message.usage.cacheRead;
                cacheWrite += entry.message.usage.cacheWrite;
                cost += entry.message.usage.cost.total;
            }
        }
        return { input, output, cacheRead, cacheWrite, cost };
    }

    function buildHeartbeat() {
        const { thinkingLevel } = latestCtx
            ? buildSessionContext(latestCtx.sessionManager.getEntries(), latestCtx.sessionManager.getLeafId())
            : { thinkingLevel: null };

        return {
            type: "heartbeat",
            active: isAgentActive,
            model: latestCtx?.model
                ? { provider: latestCtx.model.provider, id: latestCtx.model.id, name: latestCtx.model.name }
                : null,
            thinkingLevel: thinkingLevel ?? null,
            tokenUsage: buildTokenUsage(),
            cwd: latestCtx?.cwd ?? null,
            uptime: sessionStartedAt !== null ? Date.now() - sessionStartedAt : null,
            ts: Date.now(),
        };
    }

    function startHeartbeat() {
        stopHeartbeat();
        // Send an immediate heartbeat so the viewer has state right away.
        forwardEvent(buildHeartbeat());
        heartbeatTimer = setInterval(() => {
            forwardEvent(buildHeartbeat());
        }, 10_000);
    }

    function stopHeartbeat() {
        if (heartbeatTimer !== null) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    function getConfiguredModels(ctx: ExtensionContext): RelayModelInfo[] {
        return ctx.modelRegistry
            .getAvailable()
            .map((model) => ({
                provider: model.provider,
                id: model.id,
                name: model.name,
                reasoning: model.reasoning,
                contextWindow: model.contextWindow,
            }))
            .sort((a, b) => {
                if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
                return a.id.localeCompare(b.id);
            });
    }

    function buildSessionState() {
        if (!latestCtx) return undefined;
        const { messages, model, thinkingLevel } = buildSessionContext(
            latestCtx.sessionManager.getEntries(),
            latestCtx.sessionManager.getLeafId(),
        );
        return {
            messages,
            model,
            thinkingLevel,
            cwd: latestCtx.cwd,
            availableModels: getConfiguredModels(latestCtx),
        };
    }

    function buildCapabilitiesState() {
        if (!latestCtx) {
            return {
                type: "capabilities",
                models: [],
                commands: [],
            };
        }

        const commands = (pi.getCommands?.() ?? []).map((c: any) => ({
            name: c.name,
            description: c.description,
        }));

        return {
            type: "capabilities",
            models: getConfiguredModels(latestCtx),
            commands,
        };
    }

    function sendToWeb(payload: RemoteExecResponse) {
        if (!relay) return;
        send(payload);
    }

    async function handleExecFromWeb(req: RemoteExecRequest) {
        const replyOk = (result?: unknown) => sendToWeb({ type: "exec_result", id: req.id, ok: true, command: req.command, result });
        const replyErr = (error: string) => sendToWeb({ type: "exec_result", id: req.id, ok: false, command: req.command, error });

        try {
            if (req.command === "get_commands") {
                // Return the same list we already advertise in capabilities
                const commands = (pi.getCommands?.() ?? []).map((c: any) => ({ name: c.name, description: c.description }));
                replyOk({ commands });
                return;
            }

            if (req.command === "set_model") {
                await setModelFromWeb(req.provider, req.modelId);
                replyOk();
                return;
            }

            if (req.command === "cycle_model") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }
                // Naive implementation: pick the next configured model after the current one.
                const models = getConfiguredModels(latestCtx);
                const state = buildSessionState();
                const currentKey = state?.model ? `${(state.model as any).provider}/${(state.model as any).id}` : null;
                const idx = currentKey ? models.findIndex((m) => `${m.provider}/${m.id}` === currentKey) : -1;
                const next = models.length > 0 ? models[(idx + 1 + models.length) % models.length] : null;
                if (!next) {
                    replyOk(null);
                    return;
                }
                await setModelFromWeb(next.provider, next.id);
                replyOk(next);
                return;
            }

            if (req.command === "get_available_models") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }
                replyOk({ models: getConfiguredModels(latestCtx) });
                return;
            }

            if (req.command === "set_thinking_level") {
                const level = String((req as any).level ?? "").trim();
                if (!level) {
                    replyErr("Missing level");
                    return;
                }
                // Not currently exposed on ExtensionAPI; acknowledge but report unsupported.
                replyErr("set_thinking_level is not supported by the PizzaPi runner yet");
                return;
            }

            if (req.command === "cycle_thinking_level") {
                replyErr("cycle_thinking_level is not supported by the PizzaPi runner yet");
                return;
            }

            if (req.command === "set_steering_mode") {
                replyErr("set_steering_mode is not supported by the PizzaPi runner yet");
                return;
            }

            if (req.command === "set_follow_up_mode") {
                replyErr("set_follow_up_mode is not supported by the PizzaPi runner yet");
                return;
            }

            if (req.command === "compact") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }
                // ctx.compact() is fire-and-forget; wrap in a promise for request/response semantics.
                const result = await new Promise<unknown>((resolve, reject) => {
                    latestCtx!.compact({
                        customInstructions: req.customInstructions,
                        onComplete: (r) => resolve(r),
                        onError: (err) => reject(err),
                    });
                });
                replyOk(result ?? null);
                forwardEvent({ type: "session_active", state: buildSessionState() });
                return;
            }

            if (req.command === "set_session_name") {
                if (typeof pi.setSessionName !== "function") {
                    replyErr("setSessionName is not available in this pi version");
                    return;
                }
                await pi.setSessionName(req.name);
                replyOk();
                forwardEvent({ type: "session_active", state: buildSessionState() });
                return;
            }

            if (req.command === "get_last_assistant_text") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }
                const { messages } = buildSessionContext(
                    latestCtx.sessionManager.getEntries(),
                    latestCtx.sessionManager.getLeafId(),
                );
                const lastAssistant = [...messages].reverse().find((m: any) => m?.role === "assistant");
                const content = (lastAssistant as any)?.content;
                const text =
                    typeof content === "string"
                        ? content
                        : Array.isArray(content)
                          ? content
                                .filter((c: any) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
                                .map((c: any) => c.text)
                                .join("")
                          : null;
                replyOk({ text });
                return;
            }

            if (req.command === "new_session") {
                if (!latestCtx) {
                    replyErr("No active session");
                    return;
                }

                try {
                    // Uses patched pi.newSession() which delegates to
                    // AgentSession.newSession() — resets agent state, creates
                    // a new session file, and fires session lifecycle events.
                    const result = await (pi as any).newSession();
                    if (result?.cancelled) {
                        replyErr("New session was cancelled");
                        return;
                    }
                } catch (e) {
                    replyErr(e instanceof Error ? e.message : String(e));
                    return;
                }

                replyOk();
                forwardEvent({ type: "session_active", state: buildSessionState() });
                return;
            }

            if (req.command === "export_html") {
                replyErr("export_html is not implemented for remote exec yet");
                return;
            }

            replyErr(`Unknown exec command: ${String((req as any).command)}`);
        } catch (e) {
            replyErr(e instanceof Error ? e.message : String(e));
        }
    }

    async function setModelFromWeb(provider: string, modelId: string) {
        if (!latestCtx) return;

        const model = latestCtx.modelRegistry.find(provider, modelId);
        if (!model) {
            forwardEvent({
                type: "model_set_result",
                ok: false,
                provider,
                modelId,
                message: "Model is not configured for this session.",
            });
            return;
        }

        try {
            // pi.setModel() will emit a model_select event on success.
            // We only push a full session_active snapshot if the selection succeeded,
            // to avoid the UI temporarily seeing a "stale" model in session_active.
            const ok = await pi.setModel(model);
            forwardEvent({
                type: "model_set_result",
                ok,
                provider,
                modelId,
                message: ok ? undefined : "Model selected, but no valid credentials were found.",
            });
            if (ok) {
                forwardEvent({ type: "session_active", state: buildSessionState() });
            }
        } catch (error) {
            forwardEvent({
                type: "model_set_result",
                ok: false,
                provider,
                modelId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    function setRelayStatus(text?: string) {
        if (!latestCtx) return;
        latestCtx.ui.setStatus(RELAY_STATUS_KEY, text);
    }

    function consumePendingAskUserQuestionFromWeb(text: string): boolean {
        if (!pendingAskUserQuestion) return false;
        const answer = text.trim();
        if (!answer) return true;

        const pending = pendingAskUserQuestion;
        pendingAskUserQuestion = null;
        pending.resolve(answer);
        setRelayStatus(relay ? "Connected to Relay" : undefined);
        return true;
    }

    function cancelPendingAskUserQuestion() {
        if (!pendingAskUserQuestion) return;
        const pending = pendingAskUserQuestion;
        pendingAskUserQuestion = null;
        pending.resolve(null);
        setRelayStatus(relay ? "Connected to Relay" : undefined);
    }

    async function askUserQuestion(
        toolCallId: string,
        params: AskUserQuestionParams,
        signal: AbortSignal | undefined,
        ctx: ExtensionContext,
    ): Promise<{ answer: string | null; source: "tui" | "web" | null }> {
        const canAskViaWeb = !!relay && relay.ws.readyState === WebSocket.OPEN;
        const canAskViaTui = ctx.hasUI;

        if (!canAskViaWeb && !canAskViaTui) {
            return { answer: null, source: null };
        }

        const localAbort = new AbortController();

        return await new Promise((resolve) => {
            let finished = false;
            let localDone = !canAskViaTui;
            let webDone = !canAskViaWeb;

            const onAbort = () => finish(null, null);

            const maybeFinishCancelled = () => {
                if (localDone && webDone) finish(null, null);
            };

            const finish = (answer: string | null, source: "tui" | "web" | null) => {
                if (finished) return;
                finished = true;

                if (pendingAskUserQuestion?.toolCallId === toolCallId) {
                    pendingAskUserQuestion = null;
                }

                localAbort.abort();
                if (signal) signal.removeEventListener("abort", onAbort);
                setRelayStatus(relay ? "Connected to Relay" : undefined);
                resolve({ answer, source });
            };

            if (signal?.aborted) {
                finish(null, null);
                return;
            }

            if (signal) {
                signal.addEventListener("abort", onAbort, { once: true });
            }

            if (canAskViaWeb) {
                pendingAskUserQuestion = {
                    toolCallId,
                    question: params.question,
                    resolve: (answer) => {
                        webDone = true;
                        if (answer) {
                            finish(answer, "web");
                        } else {
                            maybeFinishCancelled();
                        }
                    },
                };
                setRelayStatus("Waiting for AskUserQuestion answer");
            }

            if (canAskViaTui) {
                void ctx.ui
                    .input(params.question, params.placeholder, { signal: localAbort.signal })
                    .then((value) => {
                        localDone = true;
                        const answer = value?.trim();
                        if (answer) {
                            finish(answer, "tui");
                        } else {
                            maybeFinishCancelled();
                        }
                    })
                    .catch(() => {
                        localDone = true;
                        maybeFinishCancelled();
                    });
            }

            maybeFinishCancelled();
        });
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
                    // Make sure the footer always consumes the full available width.
                    // Some terminals/fonts can make the right side look "floating" if the
                    // concatenated string ends up shorter than `width`.
                    const locationLine = layoutLeftRight(pwd, modelBadge, width, truncateMiddle);
                    const statsLine = layoutLeftRight(statsText, relayStatus, width, truncateEnd);

                    const line1Raw = locationLine.left + locationLine.pad + locationLine.right;
                    const line2Raw = statsLine.left + statsLine.pad + statsLine.right;

                    const line1Pad = " ".repeat(Math.max(0, width - line1Raw.length));
                    const line2Pad = " ".repeat(Math.max(0, width - line2Raw.length));

                    return [
                        theme.fg("dim", locationLine.left) + locationLine.pad + theme.fg("dim", locationLine.right) + line1Pad,
                        theme.fg("dim", statsLine.left) + statsLine.pad + theme.fg("success", statsLine.right) + line2Pad,
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
                    seq: 0,
                };
                setRelayStatus("Connected to Relay");

                forwardEvent({ type: "session_active", state: buildSessionState() });
                startHeartbeat();

                // Switch to steady-state message handler (collab input)
                ws.onmessage = (inputEvt) => {
                    let inputMsg: Record<string, unknown>;
                    try {
                        inputMsg = JSON.parse(inputEvt.data as string);
                    } catch {
                        return;
                    }
                    if (inputMsg.type === "connected") {
                        // A new viewer connected (web UI). Send capability snapshot.
                        forwardEvent(buildCapabilitiesState());
                        // Also send a fresh session snapshot so the viewer can populate models/messages.
                        forwardEvent({ type: "session_active", state: buildSessionState() });
                        return;
                    }

                    if (inputMsg.type === "command" && typeof inputMsg.text === "string") {
                        // Back-compat: older web UIs send /slash commands as plain text.
                        // This does NOT execute pi's TUI commands; it will be treated as a normal user message.
                        pi.sendUserMessage(inputMsg.text);
                        return;
                    }

                    if (inputMsg.type === "exec" && typeof inputMsg.id === "string" && typeof inputMsg.command === "string") {
                        void handleExecFromWeb(inputMsg as any);
                        return;
                    }

                    if (inputMsg.type === "input" && typeof inputMsg.text === "string") {
                        if (consumePendingAskUserQuestionFromWeb(inputMsg.text)) {
                            return;
                        }
                        pi.sendUserMessage(inputMsg.text);
                        return;
                    }

                    if (
                        inputMsg.type === "model_set" &&
                        typeof inputMsg.provider === "string" &&
                        typeof inputMsg.modelId === "string"
                    ) {
                        void setModelFromWeb(inputMsg.provider, inputMsg.modelId);
                    }
                };
            }
        };

        ws.onerror = () => {
            // close will fire next and handle reconnect
        };

        ws.onclose = () => {
            if (relay?.ws === ws) relay = null;
            cancelPendingAskUserQuestion();
            setRelayStatus(undefined);
            if (!shuttingDown) scheduleReconnect();
        };
    }

    function disconnect() {
        stopHeartbeat();
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        cancelPendingAskUserQuestion();
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
        sessionStartedAt = Date.now();
        isAgentActive = false;
        installFooter(ctx);
        if (isDisabled()) {
            setRelayStatus(undefined);
            return;
        }
        connect();
    });

    pi.on("session_switch", (_event, ctx) => {
        latestCtx = ctx;
        sessionStartedAt = Date.now();
        isAgentActive = false;
        installFooter(ctx);
        setRelayStatus(pendingAskUserQuestion ? "Waiting for AskUserQuestion answer" : relay ? "Connected to Relay" : undefined);
        forwardEvent({ type: "session_active", state: buildSessionState() });
        forwardEvent(buildHeartbeat());
    });

    pi.on("session_shutdown", () => {
        shuttingDown = true;
        stopHeartbeat();
        disconnect();
    });

    // ── AskUserQuestion tool ──────────────────────────────────────────────────

    pi.registerTool({
        name: ASK_USER_TOOL_NAME,
        label: "Ask User Question",
        description:
            "Ask the user a clarification question and wait for a response. Use this when you must collect user input before continuing.",
        parameters: {
            type: "object",
            properties: {
                question: {
                    type: "string",
                    description: "The question to ask the user.",
                },
                placeholder: {
                    type: "string",
                    description: "Optional placeholder hint for the answer input.",
                },
            },
            required: ["question"],
            additionalProperties: false,
        } as any,
        async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
            if (pendingAskUserQuestion && pendingAskUserQuestion.toolCallId !== toolCallId) {
                return {
                    content: [{ type: "text", text: "A different AskUserQuestion prompt is already pending." }],
                    details: {
                        question: pendingAskUserQuestion.question,
                        answer: null,
                        source: null,
                        cancelled: true,
                    } satisfies AskUserQuestionDetails,
                };
            }

            const params = (rawParams ?? {}) as AskUserQuestionParams;
            const question = params.question?.trim();

            if (!question) {
                return {
                    content: [{ type: "text", text: "AskUserQuestion requires a non-empty question." }],
                    details: {
                        question: "",
                        answer: null,
                        source: null,
                        cancelled: true,
                    } satisfies AskUserQuestionDetails,
                };
            }

            onUpdate?.({
                content: [{ type: "text", text: `Waiting for answer: ${question}` }],
                details: {
                    question,
                    answer: null,
                    source: null,
                    cancelled: false,
                    status: "waiting",
                } satisfies AskUserQuestionDetails,
            });

            const result = await askUserQuestion(
                toolCallId,
                { question, placeholder: params.placeholder },
                signal,
                ctx,
            );

            if (!result.answer) {
                return {
                    content: [{ type: "text", text: "User did not provide an answer." }],
                    details: {
                        question,
                        answer: null,
                        source: null,
                        cancelled: true,
                    } satisfies AskUserQuestionDetails,
                };
            }

            onUpdate?.({
                content: [{ type: "text", text: `Answer received: ${result.answer}` }],
                details: {
                    question,
                    answer: result.answer,
                    source: result.source,
                    cancelled: false,
                    status: "answered",
                } satisfies AskUserQuestionDetails,
            });

            return {
                content: [{ type: "text", text: `User answered: ${result.answer}` }],
                details: {
                    question,
                    answer: result.answer,
                    source: result.source,
                    cancelled: false,
                } satisfies AskUserQuestionDetails,
            };
        },
    });

    // ── /remote command ───────────────────────────────────────────────────────

    pi.registerCommand("remote", {
        description: "Show relay share URL, or: /remote stop | /remote reconnect",
        getArgumentCompletions: (prefix) => {
            const options = ["stop", "reconnect"];
            const filtered = options.filter((o) => o.startsWith(prefix.trim().toLowerCase()));
            return filtered.length ? filtered.map((o) => ({ value: o, label: o })) : null;
        },
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

    pi.on("agent_start", (event) => {
        isAgentActive = true;
        forwardEvent(event);
        // Push an immediate heartbeat so viewers see "active" without waiting 10s.
        forwardEvent(buildHeartbeat());
    });
    pi.on("agent_end", (event) => {
        isAgentActive = false;
        forwardEvent(event);
        // Push a heartbeat immediately so viewers see "idle" after the turn.
        forwardEvent(buildHeartbeat());
    });
    pi.on("turn_start", (event) => forwardEvent(event));
    pi.on("turn_end", (event) => forwardEvent(event));
    pi.on("message_start", (event) => forwardEvent(event));
    pi.on("message_update", (event) => forwardEvent(event));
    pi.on("message_end", (event) => forwardEvent(event));
    pi.on("tool_execution_start", (event) => forwardEvent(event));
    pi.on("tool_execution_update", (event) => forwardEvent(event));
    pi.on("tool_execution_end", (event) => forwardEvent(event));
    pi.on("model_select", (event) => {
        forwardEvent(event);
        forwardEvent({ type: "session_active", state: buildSessionState() });
    });
};
