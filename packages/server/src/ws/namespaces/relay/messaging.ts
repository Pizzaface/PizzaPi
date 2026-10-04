// ── Inter-session messaging handlers ─────────────────────────────────────────
// Handles session_message, session_trigger, and trigger_response events.

import {
    getSharedSession,
    getSharedSessionSummary,
    getLocalTuiSocket,
    emitToRelaySessionVerified,
    emitToRelaySessionInputAck,
    hasRelaySessionListener,
    broadcastToSessionViewers,
} from "../../sio-registry.js";
import {
    getChildSessions,
    isChildOfParent,
    isPendingParentDelinkChild,
    refreshChildSessionsTTL,
} from "../../sio-state/index.js";
import { pushTriggerHistory, recordTriggerResponse } from "../../../sessions/trigger-store.js";
import type { RelaySocket } from "./types.js";

export function registerMessagingHandlers(socket: RelaySocket): void {
    const deliverSessionMessage = async (
        fromSessionId: string,
        targetSessionId: string,
        messageText: string,
        deliverAs: "input" | "steer" | undefined,
    ): Promise<{ ok: boolean; error?: string }> => {
        const isInput = deliverAs === "input" || deliverAs === "steer";
        const inputDelivery = deliverAs === "steer" ? "steer" : "followUp";
        const targetSocket = getLocalTuiSocket(targetSessionId);
        const attributedText = `Message from linked session ${fromSessionId}:\n\n${messageText}`;
        const payload = isInput
            ? { text: attributedText, attachments: [], client: "agent", fromSessionId, deliverAs: inputDelivery }
            : { fromSessionId, message: messageText, ts: new Date().toISOString() };

        if (targetSocket?.connected) {
            try {
                if (isInput) {
                    const delivered = await new Promise<boolean>((resolve) => {
                        targetSocket.timeout(10_000).emit("input" as string, payload, (err: unknown, response: unknown) => {
                            resolve(!err && (response === true || (Array.isArray(response) && response.some((r) => r === true))));
                        });
                    });
                    return delivered ? { ok: true } : { ok: false, error: "Target session did not acknowledge delivery" };
                }
                targetSocket.emit("session_message" as string, payload);
                return { ok: true };
            } catch {
                return { ok: false, error: "Failed to deliver message to target session" };
            }
        }

        if (isInput) {
            const result = await emitToRelaySessionInputAck(targetSessionId, "input", payload);
            if (!result.hadListeners) return { ok: false, error: "Target session not found or not connected" };
            return result.delivered ? { ok: true } : { ok: false, error: "Target session did not acknowledge delivery" };
        }

        return await emitToRelaySessionVerified(targetSessionId, "session_message", payload)
            ? { ok: true }
            : { ok: false, error: "Target session not found or not connected" };
    };

    // ── session_message — inter-session messaging ────────────────────────
    socket.on("session_message", async (data, ack) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId || !data || data.token !== socket.data.token) {
            socket.emit("error", { message: "Invalid token" });
            ack?.({ ok: false, error: "Invalid token" });
            return;
        }

        const messageText = typeof data.message === "string" ? data.message : "";
        if (!messageText.trim()) {
            socket.emit("error", { message: "session_message requires non-empty message" });
            ack?.({ ok: false, error: "session_message requires non-empty message" });
            return;
        }

        const targetKind = data.target ?? "session";
        const directTargetSessionId = typeof data.targetSessionId === "string" ? data.targetSessionId.trim() : "";
        const validTarget = data.target === undefined
            ? directTargetSessionId.length > 0
            : data.target === "session"
                ? directTargetSessionId.length > 0
                : (data.target === "parent" || data.target === "children") && directTargetSessionId.length === 0;
        if (!validTarget) {
            const error = "session_message requires exactly one target: targetSessionId, target:'parent', or target:'children'";
            socket.emit("error", { message: error });
            ack?.({ ok: false, error });
            return;
        }

        const isInput = data.deliverAs === "input" || data.deliverAs === "steer";
        const senderSession = await getSharedSessionSummary(sessionId);
        if (!senderSession?.userId) {
            const error = "Sender session not found";
            socket.emit("session_message_error", { targetSessionId: directTargetSessionId || targetKind, error });
            ack?.({ ok: false, error });
            return;
        }

        const resolveTargetIds = async (): Promise<{ ids: string[]; error?: string }> => {
            if (targetKind === "parent") {
                const parentId = senderSession.parentSessionId ?? senderSession.linkedParentId ?? null;
                if (!parentId) return { ids: [], error: "Sender has no linked parent session" };
                if (await isPendingParentDelinkChild(parentId, sessionId)) return { ids: [], error: "Sender is currently being delinked from the target session" };
                if (!await isChildOfParent(parentId, sessionId)) return { ids: [], error: "Sender is no longer a child of the target session (linked relationship is broken or stale)" };
                return { ids: [parentId] };
            }
            if (targetKind === "children") {
                const children = await getChildSessions(sessionId);
                const direct: string[] = [];
                for (const childId of children) {
                    const child = await getSharedSessionSummary(childId);
                    if (!child || child.userId !== senderSession.userId) continue;
                    if ((child.parentSessionId ?? child.linkedParentId) !== sessionId) continue;
                    if (!await isChildOfParent(sessionId, childId)) continue;
                    if (!getLocalTuiSocket(childId)?.connected && !await hasRelaySessionListener(childId)) continue;
                    direct.push(childId);
                }
                return { ids: direct };
            }
            return { ids: [directTargetSessionId] };
        };

        const resolved = await resolveTargetIds();
        if (resolved.error) {
            socket.emit("session_message_error", { targetSessionId: directTargetSessionId || targetKind, error: resolved.error });
            ack?.({ ok: false, error: resolved.error });
            return;
        }
        if (resolved.ids.length === 0) {
            const error = targetKind === "children" ? "No direct child sessions" : "Target session not found or not connected";
            socket.emit("session_message_error", { targetSessionId: directTargetSessionId || targetKind, error });
            ack?.({ ok: false, delivered: [], errors: [{ targetSessionId: directTargetSessionId || targetKind, error }] });
            return;
        }

        const results = await Promise.all(resolved.ids.map(async (targetSessionId): Promise<{ targetSessionId: string; ok: boolean; error?: string }> => {
            const targetSession = await getSharedSessionSummary(targetSessionId);
            if (!targetSession) return { targetSessionId, ok: false, error: "Target session not found or not connected" };
            if (!targetSession.userId || senderSession.userId !== targetSession.userId) {
                return { targetSessionId, ok: false, error: "Target session belongs to a different user" };
            }

            const senderParent = senderSession.parentSessionId ?? senderSession.linkedParentId ?? null;
            const targetParent = targetSession.parentSessionId ?? targetSession.linkedParentId ?? null;
            const parentToChild = targetParent === sessionId;
            const childToParent = senderParent === targetSessionId;
            const legacyBus = !isInput && targetKind === "session";
            if (!legacyBus && !parentToChild && !childToParent) {
                return { targetSessionId, ok: false, error: "Target is not a linked parent or direct child of the sender" };
            }
            if (parentToChild && (await isPendingParentDelinkChild(sessionId, targetSessionId) || !await isChildOfParent(sessionId, targetSessionId))) {
                return { targetSessionId, ok: false, error: "Target session is not a child of the sender (linked relationship is broken or stale)" };
            }
            if (childToParent && (await isPendingParentDelinkChild(targetSessionId, sessionId) || !await isChildOfParent(targetSessionId, sessionId))) {
                return { targetSessionId, ok: false, error: "Sender is no longer a child of the target session (linked relationship is broken or stale)" };
            }

            const result = await deliverSessionMessage(sessionId, targetSessionId, messageText, data.deliverAs);
            return result.ok
                ? { targetSessionId, ok: true }
                : { targetSessionId, ok: false, error: result.error ?? "Failed to deliver message to target session" };
        }));

        const delivered = results.filter((r) => r.ok).map((r) => r.targetSessionId);
        const errors = results
            .filter((r) => !r.ok)
            .map((r) => ({ targetSessionId: r.targetSessionId, error: r.error ?? "Failed to deliver message to target session" }));
        for (const err of errors) socket.emit("session_message_error", err);
        ack?.({ ok: errors.length === 0, delivered, errors });
    });

    // ── session_trigger — child-to-parent trigger routing ────────────────
    socket.on("session_trigger", async (data, ack?: (result: { ok: boolean; error?: string }) => void) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId || data?.token !== socket.data.token) {
            socket.emit("error", { message: "Invalid token" });
            ack?.({ ok: false, error: "Invalid token" });
            return;
        }

        const trigger = data?.trigger;
        if (!trigger?.targetSessionId || !trigger?.triggerId) {
            socket.emit("error", { message: "session_trigger requires trigger with targetSessionId and triggerId" });
            ack?.({ ok: false, error: "session_trigger requires trigger with targetSessionId and triggerId" });
            return;
        }

        const targetSessionId = trigger.targetSessionId;

        // Find the target session's relay socket and validate ownership
        const [senderSession, targetSession] = await Promise.all([
            getSharedSessionSummary(sessionId),
            getSharedSessionSummary(targetSessionId),
        ]);
        if (!targetSession) {
            const error = `Target session ${targetSessionId} is not connected`;
            socket.emit("session_message_error", {
                targetSessionId,
                error,
                triggerId: trigger.triggerId,
            });
            ack?.({ ok: false, error });
            return;
        }

        // Validate that the target session belongs to the same user
        if (!senderSession?.userId || senderSession.userId !== targetSession.userId) {
            socket.emit("error", { message: "Target session belongs to a different user" });
            ack?.({ ok: false, error: "Target session belongs to a different user" });
            return;
        }

        if (targetSessionId !== sessionId && await isPendingParentDelinkChild(targetSessionId, sessionId)) {
            const error = "Sender is currently being delinked from the target session";
            socket.emit("session_message_error", {
                targetSessionId,
                error,
                triggerId: trigger.triggerId,
            });
            ack?.({ ok: false, error });
            return;
        }

        // Reject triggers from sessions that are no longer children of the target.
        // This closes a race window after delink_children: a connected child that
        // emits session_trigger before it processes parent_delinked could otherwise
        // inject a stale trigger into the parent's new conversation.
        // Self-triggers (escalations) are explicitly excluded.
        if (targetSessionId !== sessionId) {
            const senderIsChild = await isChildOfParent(targetSessionId, sessionId);
            if (!senderIsChild) {
                const error = "Sender is no longer a child of the target session (linked relationship is broken or stale)";
                socket.emit("session_message_error", {
                    targetSessionId,
                    error,
                    triggerId: trigger.triggerId,
                });
                ack?.({ ok: false, error });
                return;
            }
            await refreshChildSessionsTTL(targetSessionId);
        }

        // For escalations targeting the sender's own session, preserve the
        // original child sourceSessionId so the viewer can attribute the
        // escalation to the correct child. For all other triggers, enforce
        // server-side identity to prevent spoofing.
        if (trigger.type === "escalate" && targetSessionId === sessionId) {
            // Escalation to self — keep original sourceSessionId for viewer attribution
        } else {
            trigger.sourceSessionId = sessionId;
        }

        let delivered = false;
        const targetSocket = getLocalTuiSocket(targetSessionId);
        if (targetSocket?.connected) {
            try {
                targetSocket.emit("session_trigger" as any, { trigger });
                delivered = true;
            } catch {
                const error = "Failed to deliver trigger to target session";
                socket.emit("session_message_error", {
                    targetSessionId,
                    error,
                    triggerId: trigger.triggerId,
                });
                ack?.({ ok: false, error });
                return;
            }
        } else if (await emitToRelaySessionVerified(targetSessionId, "session_trigger", { trigger })) {
            delivered = true;
        } else {
            // Cross-node fallback: target TUI socket is on a different server node.
            // emitToRelaySessionVerified returns false when no relay recipient is present.
            const error = `Target session ${targetSessionId} is not connected`;
            socket.emit("session_message_error", {
                targetSessionId,
                error,
                triggerId: trigger.triggerId,
            });
            ack?.({ ok: false, error });
            return;
        }

        // Record in trigger history so the history API and linked-sessions
        // derivation have data to work with. Also poke viewers so the
        // TriggersPanel can refresh immediately instead of waiting for the
        // next 10s poll cycle.
        if (delivered) {
            void Promise.resolve(pushTriggerHistory(targetSessionId, {
                triggerId: trigger.triggerId,
                type: trigger.type ?? "session_trigger",
                source: trigger.sourceSessionId ?? sessionId,
                summary: trigger.sourceSessionName,
                payload: trigger.payload ?? {},
                deliverAs: trigger.deliverAs ?? "steer",
                ts: trigger.ts ?? new Date().toISOString(),
                direction: "inbound",
            })).catch(() => {});
            broadcastToSessionViewers(targetSessionId, "trigger_delivered", {
                triggerId: trigger.triggerId,
            });
        }
        ack?.({ ok: true });
    });

    // ── trigger_response — parent-to-child response routing ────────────
    socket.on("trigger_response" as any, async (data: {
        token: string;
        triggerId: string;
        response: string;
        action?: string;
        targetSessionId: string;
    }, ack: ((result: { ok: boolean; error?: string }) => void) | undefined) => {
        const { triggerId, response, action, targetSessionId } = data ?? {};
        if (!triggerId || response == null || !targetSessionId) {
            socket.emit("error", { message: "trigger_response requires triggerId, response, and targetSessionId" });
            if (typeof ack === "function") ack({ ok: false, error: "Missing required fields" });
            return;
        }

        // Validate sender is authenticated and token matches
        if (!socket.data.sessionId || data?.token !== socket.data.token) {
            socket.emit("error", { message: "Invalid token" });
            if (typeof ack === "function") ack({ ok: false, error: "Invalid token" });
            return;
        }

        // Validate that the target session belongs to the same user
        const [senderSession, targetSession] = await Promise.all([
            getSharedSessionSummary(socket.data.sessionId),
            getSharedSessionSummary(targetSessionId),
        ]);

        // If the target session no longer exists (e.g. runner/server restarted
        // and the old child session was already cleaned up), treat the
        // trigger_response as a no-op success.  The trigger is implicitly
        // cancelled when its session is gone — retrying forever would just
        // spam the logs.  We specifically check for a missing target session
        // (as opposed to a userId mismatch) to keep the security guard for
        // cross-user access intact.
        if (!targetSession) {
            if (typeof ack === "function") ack({ ok: true });
            return;
        }

        if (!senderSession?.userId || !targetSession.userId || senderSession.userId !== targetSession.userId) {
            socket.emit("error", { message: "Target session belongs to a different user" });
            if (typeof ack === "function") ack({ ok: false, error: "Target session belongs to a different user" });
            return;
        }

        // Enforce parent→child direction: trigger_response should only flow
        // from a parent to its child. The reverse direction (child→parent) is
        // not needed — children emit session_trigger to parents, and parents
        // respond with trigger_response to children. Allowing child→parent
        // would let a sibling session inject responses into another child's
        // pending trigger through the parent's forwarding handler.
        //
        // Fall back to the children membership set when the child's session
        // hash has parentSessionId=null because the parent was transiently
        // offline during the child's last reconnect (Fix #3: the set membership
        // is preserved by addChildSessionMembership in that path).
        const isParentOfTarget = targetSession.parentSessionId === socket.data.sessionId
            || await isChildOfParent(socket.data.sessionId, targetSessionId);
        if (!isParentOfTarget) {
            socket.emit("error", { message: "Sender is not the parent of the target session (linked relationship is broken or stale)" });
            if (typeof ack === "function") ack({ ok: false, error: "Sender is not the parent of the target session (linked relationship is broken or stale)" });
            return;
        }

        const triggerPayload = { triggerId, response, ...(action ? { action } : {}) };
        // Try local socket first, then verified room delivery for cross-node
        // routing. We only ack success when at least one relay recipient is
        // actually present.
        // The parent session ID (sender) owns the trigger history entry.
        const parentSessionId = socket.data.sessionId!;

        const targetSocket = getLocalTuiSocket(targetSessionId);
        if (targetSocket?.connected) {
            try {
                targetSocket.emit("trigger_response" as any, triggerPayload);
                // Record the response in the parent's trigger history so the
                // TriggersPanel shows it as responded (not perpetually pending).
                void recordTriggerResponse(parentSessionId, triggerId, { action, text: response }).catch(() => {});
                broadcastToSessionViewers(parentSessionId, "trigger_delivered", { triggerId });
                if (typeof ack === "function") ack({ ok: true });
            } catch {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Failed to deliver trigger response to target session",
                });
                if (typeof ack === "function") ack({ ok: false, error: "Failed to deliver trigger response to target session" });
            }
        } else if (!await emitToRelaySessionVerified(targetSessionId, "trigger_response", triggerPayload)) {
            socket.emit("session_message_error", {
                targetSessionId,
                error: `Target session ${targetSessionId} is not connected`,
            });
            if (typeof ack === "function") ack({ ok: false, error: `Target session ${targetSessionId} is not connected` });
        } else {
            void recordTriggerResponse(parentSessionId, triggerId, { action, text: response }).catch(() => {});
            broadcastToSessionViewers(parentSessionId, "trigger_delivered", { triggerId });
            if (typeof ack === "function") ack({ ok: true });
        }
    });

    // ── trigger_status_update — ephemeral progress updates for triggers ──
    // A child session can push status text for a trigger it previously sent
    // to its parent. This is NOT stored in trigger history — it's a
    // real-time-only update broadcast to the parent's viewers so the
    // TriggersPanel can show live progress (e.g. "Working on step 3/7").
    socket.on("trigger_status_update" as any, async (data: {
        token: string;
        triggerId: string;
        targetSessionId: string;
        statusText: string;
    }) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId || data?.token !== socket.data.token) {
            socket.emit("error", { message: "Invalid token" });
            return;
        }

        const { triggerId, targetSessionId, statusText } = data ?? {};
        if (!triggerId || !targetSessionId || typeof statusText !== "string") {
            socket.emit("error", { message: "trigger_status_update requires triggerId, targetSessionId, statusText" });
            return;
        }

        // Validate same-user ownership
        const senderSession = await getSharedSession(sessionId);
        const targetSession = await getSharedSession(targetSessionId);
        if (!senderSession?.userId || !targetSession?.userId || senderSession.userId !== targetSession.userId) {
            return; // silently drop — not critical
        }

        // Security: also verify sender is a child of the target (parent) session.
        // Prevents a session from spoofing trigger progress updates into a parent
        // it isn't actually linked to (same guard used by session_trigger handlers).
        const senderIsChild = await isChildOfParent(targetSessionId, sessionId);
        if (!senderIsChild) {
            return; // silently drop — sender is not a child of the target
        }

        // Broadcast to viewers of the target (parent) session
        broadcastToSessionViewers(targetSessionId, "trigger_status_update", {
            triggerId,
            sourceSessionId: sessionId,
            statusText,
            ts: new Date().toISOString(),
        });
    });
}
