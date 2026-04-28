import type { Socket } from "socket.io-client";
import type { RelayClientToServerEvents, RelayServerToClientEvents } from "@pizzapi/protocol";
import type { ConversationTrigger } from "../triggers/types.js";

const DEFAULT_SESSION_COMPLETE_ACK_TIMEOUT_MS = 3_000;

type RelayTriggerSocket = Pick<Socket<RelayServerToClientEvents, RelayClientToServerEvents>, "emit" | "on" | "off"> & {
    connected?: boolean;
};

export interface EmitSessionTriggerWithAckOptions {
    socket: RelayTriggerSocket;
    token: string;
    trigger: ConversationTrigger;
    timeoutMs?: number;
    assumeSuccessOnAckTimeout?: boolean;
}

export interface EmitSessionCompleteWithAckOptions {
    socket: RelayTriggerSocket;
    token: string;
    sourceSessionId: string;
    targetSessionId: string;
    triggerId: string;
    summary: string;
    exitReason: "completed" | "killed" | "error";
    fullOutputPath?: string;
    timeoutMs?: number;
    assumeSuccessOnAckTimeout?: boolean;
}

function buildSessionCompleteTrigger(
    opts: EmitSessionCompleteWithAckOptions,
): ConversationTrigger {
    return {
        type: "session_complete",
        sourceSessionId: opts.sourceSessionId,
        sourceSessionName: undefined,
        targetSessionId: opts.targetSessionId,
        payload: {
            summary: opts.summary,
            exitCode: opts.exitReason === "killed" ? 130 : opts.exitReason === "error" ? 1 : 0,
            exitReason: opts.exitReason,
            ...(opts.fullOutputPath ? { fullOutputPath: opts.fullOutputPath } : {}),
        },
        deliverAs: "followUp",
        expectsResponse: true,
        triggerId: opts.triggerId,
        ts: new Date().toISOString(),
    };
}

export async function emitSessionTriggerWithAck(
    opts: EmitSessionTriggerWithAckOptions,
): Promise<{ ok: boolean; error?: string }> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_SESSION_COMPLETE_ACK_TIMEOUT_MS;

    return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        let settled = false;
        let sawDisconnect = false;
        const errorHandler = (data: { targetSessionId: string; error: string; triggerId?: string }) => {
            if (data?.targetSessionId !== opts.trigger.targetSessionId) return;
            if (data.triggerId === opts.trigger.triggerId) {
                finish({ ok: false, error: data.error });
                return;
            }
            if (opts.assumeSuccessOnAckTimeout === true && data.triggerId == null) {
                finish({ ok: false, error: data.error });
            }
        };
        const disconnectHandler = () => {
            sawDisconnect = true;
        };
        const finish = (result: { ok: boolean; error?: string }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            opts.socket.off?.("session_message_error", errorHandler);
            opts.socket.off?.("disconnect", disconnectHandler);
            resolve(result);
        };

        const timeout = setTimeout(() => {
            if (sawDisconnect || opts.socket.connected === false) {
                finish({ ok: false, error: "Socket disconnected before relay ack" });
                return;
            }
            if (opts.assumeSuccessOnAckTimeout === true) {
                finish({ ok: true });
                return;
            }
            finish({ ok: false, error: `Timed out waiting for relay ack after ${timeoutMs}ms` });
        }, timeoutMs);

        opts.socket.on?.("session_message_error", errorHandler);
        opts.socket.on?.("disconnect", disconnectHandler);

        try {
            opts.socket.emit(
                "session_trigger" as any,
                { token: opts.token, trigger: opts.trigger },
                (result?: { ok: boolean; error?: string }) => {
                    finish(result ?? { ok: true });
                },
            );
        } catch (err) {
            finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
    });
}

export async function emitSessionCompleteWithAck(
    opts: EmitSessionCompleteWithAckOptions,
): Promise<{ ok: boolean; error?: string }> {
    return await emitSessionTriggerWithAck({
        socket: opts.socket,
        token: opts.token,
        trigger: buildSessionCompleteTrigger(opts),
        timeoutMs: opts.timeoutMs,
        assumeSuccessOnAckTimeout: opts.assumeSuccessOnAckTimeout,
    });
}
