/**
 * RelayContext factory.
 *
 * Creates and returns the `RelayContext` object that is threaded through all
 * remote-extension sub-modules.  Behaviour mirrors the original inline object
 * literal in remote/index.ts.
 *
 * Extracted from remote/index.ts.
 */

import { randomUUID } from "node:crypto";
import { buildSessionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../../config.js";
import { buildHeartbeat } from "../remote-heartbeat.js";
import { getCurrentTodoList } from "../update-todo.js";
import { isDisabled, toWebSocketBaseUrl } from "./connection.js";
import type { RelayContext, RelayModelInfo, TriggerResponse } from "../remote-types.js";
import type { RemoteExecResponse } from "../remote-commands.js";
import type { ConversationTrigger } from "../triggers/types.js";
import { isCancelTriggerAction } from "../remote-trigger-response.js";
import type { TriggerWaitManager } from "../trigger-wait-manager.js";
import { emitSessionActive } from "./chunked-delivery.js";

const RELAY_DEFAULT = "ws://localhost:7492";
const RELAY_STATUS_KEY = "relay";

/** Subset of shared factory state that relay-context-factory needs to mutate. */
export interface RelayContextFactoryState {
    /** Most-recently broadcast session name — shared with session-name-sync. */
    lastBroadcastSessionName: string | null;
}

/**
 * Build the RelayContext object for a new extension factory invocation.
 *
 * @param pi           The pi extension API.
 * @param triggerWaits Manager for in-flight trigger-response waits.
 * @param state        Shared mutable state (lastBroadcastSessionName).
 */
export function createRelayContext(
    pi: any,
    triggerWaits: TriggerWaitManager,
    state: RelayContextFactoryState,
): RelayContext {
    const rctx: RelayContext = {
        pi,
        relay: null,
        sioSocket: null,
        latestCtx: null,

        isAgentActive: false,
        isCompacting: false,
        shuttingDown: false,
        wasAborted: false,
        sessionStartedAt: null,
        lastRetryableError: null,

        parentSessionId: process.env.PIZZAPI_WORKER_PARENT_SESSION_ID ?? null,
        isChildSession: (process.env.PIZZAPI_WORKER_PARENT_SESSION_ID ?? null) !== null,
        relaySessionId:
            process.env.PIZZAPI_SESSION_ID && process.env.PIZZAPI_SESSION_ID.trim().length > 0
                ? process.env.PIZZAPI_SESSION_ID.trim()
                : randomUUID(),

        pendingAskUserQuestion: null,
        pendingPlanMode: null,
        pendingPluginTrust: null,

        lastMcpStartupReport: null,
        relayStatusText: "",

        forwardEvent(event: unknown) {
            if (!rctx.relay || !rctx.sioSocket?.connected) return;
            const seq = ++rctx.relay.seq;
            rctx.sioSocket.emit("event", {
                sessionId: rctx.relay.sessionId,
                token: rctx.relay.token,
                event,
                seq,
            });
        },

        sendToWeb(payload: RemoteExecResponse) {
            if (!rctx.relay || !rctx.sioSocket?.connected) return;
            const { type: _, ...data } = payload;
            rctx.sioSocket.emit("exec_result", data);
        },

        relayUrl(): string {
            const configured =
                process.env.PIZZAPI_RELAY_URL ??
                loadConfig(process.cwd()).relayUrl ??
                RELAY_DEFAULT;
            return configured.replace(/\/$/, "");
        },

        relayHttpBaseUrl(): string {
            const wsBase = toWebSocketBaseUrl(rctx.relayUrl()).replace(/\/ws\/sessions$/, "");
            if (wsBase.startsWith("ws://")) return `http://${wsBase.slice("ws://".length)}`;
            if (wsBase.startsWith("wss://")) return `https://${wsBase.slice("wss://".length)}`;
            return wsBase;
        },

        apiKey(): string | undefined {
            return (
                process.env.PIZZAPI_API_KEY ??
                process.env.PIZZAPI_API_TOKEN ??
                loadConfig(process.cwd()).apiKey
            );
        },

        setRelayStatus(text?: string) {
            rctx.relayStatusText = text ?? "";
            if (!rctx.latestCtx) return;
            rctx.latestCtx.ui.setStatus(RELAY_STATUS_KEY, text);
        },

        disconnectedStatusText(): string | undefined {
            if (isDisabled()) return undefined;
            if (!rctx.apiKey()) return "Relay not configured — run pizza setup";
            return "Disconnected from Relay";
        },

        isConnected(): boolean {
            return !!rctx.relay && !!rctx.sioSocket?.connected;
        },

        buildSessionState() {
            if (!rctx.latestCtx) return undefined;
            const { messages, model } = buildSessionContext(
                rctx.latestCtx.sessionManager.getEntries(),
                rctx.latestCtx.sessionManager.getLeafId(),
            );
            return {
                messages,
                model,
                thinkingLevel: rctx.getCurrentThinkingLevel(),
                sessionName: rctx.getCurrentSessionName(),
                cwd: rctx.latestCtx.cwd,
                availableModels: rctx.getConfiguredModels(),
                todoList: getCurrentTodoList(),
            };
        },

        emitSessionActive() {
            emitSessionActive(rctx);
        },

        buildHeartbeat() {
            return buildHeartbeat(rctx);
        },

        getAvailableCommands(): Array<{ name: string; description?: string; source?: string }> {
            if (!rctx.latestCtx) return [];
            return ((pi as any).getCommands?.() ?? []).map((c: any) => ({
                name: c.name,
                description: c.description,
                source: c.source,
            }));
        },

        buildCapabilitiesState() {
            return {
                type: "capabilities",
                models: rctx.getConfiguredModels(),
                commands: rctx.getAvailableCommands(),
            };
        },

        getConfiguredModels(): RelayModelInfo[] {
            if (!rctx.latestCtx) return [];
            return rctx.latestCtx.modelRegistry
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
        },

        getCurrentSessionName(): string | null {
            if (!rctx.latestCtx) return null;
            const raw = rctx.latestCtx.sessionManager.getSessionName();
            if (typeof raw !== "string") return null;
            const trimmed = raw.trim();
            return trimmed.length > 0 ? trimmed : null;
        },

        getCurrentThinkingLevel(): string | null {
            const api = pi as any;
            if (typeof api.getThinkingLevel === "function") {
                const level = api.getThinkingLevel();
                if (typeof level === "string") {
                    const trimmed = level.trim();
                    if (trimmed) return trimmed;
                }
            }
            if (!rctx.latestCtx) return null;
            const { thinkingLevel } = buildSessionContext(
                rctx.latestCtx.sessionManager.getEntries(),
                rctx.latestCtx.sessionManager.getLeafId(),
            );
            return thinkingLevel ?? null;
        },

        markSessionNameBroadcasted() {
            // Shared state — also read/written by session-name-sync interval.
            state.lastBroadcastSessionName = rctx.getCurrentSessionName();
        },

        emitTrigger(trigger: ConversationTrigger) {
            if (!rctx.relay || !rctx.sioSocket?.connected) return;
            rctx.sioSocket.emit("session_trigger" as any, {
                token: rctx.relay.token,
                trigger,
            });
        },

        waitForTriggerResponse(
            triggerId: string,
            timeoutMs: number,
            signal?: AbortSignal,
        ): Promise<TriggerResponse> {
            return new Promise<TriggerResponse>((resolve) => {
                const expectedParentSessionId = rctx.parentSessionId;
                let settled = false;
                let unregisterWait = () => {};

                const finish = (result: TriggerResponse) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve(result);
                };

                const timeout = setTimeout(() => {
                    finish({
                        response: "Trigger timed out — no response from parent within 5 minutes.",
                        cancelled: true,
                    });
                }, timeoutMs);

                const handler = (data: { triggerId: string; response: string; action?: string }) => {
                    if (data.triggerId === triggerId) {
                        finish({
                            response: data.response,
                            action: data.action,
                            cancelled: isCancelTriggerAction(data.action),
                        });
                    }
                };

                const errorHandler = (data: { targetSessionId: string; error: string }) => {
                    if (expectedParentSessionId && data.targetSessionId === expectedParentSessionId) {
                        finish({
                            response: `Trigger delivery failed: ${data.error}`,
                            cancelled: true,
                        });
                    }
                };

                const abortHandler = () => {
                    finish({ response: "Aborted", cancelled: true });
                };

                const cleanup = () => {
                    clearTimeout(timeout);
                    unregisterWait();
                    rctx.sioSocket?.off("trigger_response" as any, handler);
                    rctx.sioSocket?.off("session_message_error" as any, errorHandler);
                    signal?.removeEventListener("abort", abortHandler);
                };

                unregisterWait = triggerWaits.register(triggerId, finish);
                rctx.sioSocket!.on("trigger_response" as any, handler);
                rctx.sioSocket!.on("session_message_error" as any, errorHandler);
                signal?.addEventListener("abort", abortHandler);
            });
        },
    };

    return rctx;
}
