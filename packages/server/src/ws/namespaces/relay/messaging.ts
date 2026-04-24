// ── Inter-session messaging handlers ─────────────────────────────────────────
// Handles session_message, session_trigger, and trigger_response events.

import {
    getSharedSession,
    getLocalTuiSocket,
    emitToRelaySessionVerified,
    broadcastToSessionViewers,
} from "../../sio-registry.js";
import {
    isChildOfParent,
    isPendingParentDelinkChild,
    refreshChildSessionsTTL,
} from "../../sio-state/index.js";
import { pushTriggerHistory, recordTriggerResponse } from "../../../sessions/trigger-store.js";
import type { RelaySocket } from "./types.js";

export function registerMessagingHandlers(socket: RelaySocket): void {
    // ── session_message — inter-session messaging ────────────────────────
    socket.on("session_message", async (data) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId || data.token !== socket.data.token) {
            socket.emit("error", { message: "Invalid token" });
            return;
        }

        const targetSessionId = data.targetSessionId;
        const messageText = data.message;
        if (!targetSessionId || !messageText) {
            socket.emit("error", { message: "session_message requires targetSessionId and message" });
            return;
        }

        const senderSession = await getSharedSession(sessionId);
        const targetSession = await getSharedSession(targetSessionId);
        if (!targetSession) {
            socket.emit("session_message_error", {
                targetSessionId,
                error: "Target session not found or not connected",
            });
            return;
        }

        // Enforce same-user ownership to prevent cross-user message injection,
        // especially for deliverAs:"input" which starts new agent turns.
        if (!senderSession?.userId || !targetSession?.userId || senderSession.userId !== targetSession.userId) {
            socket.emit("session_message_error", {
                targetSessionId,
                error: "Target session belongs to a different user",
            });
            return;
        }

        // Block messages from delinked children. If the sender's session
        // still carries a parentSessionId pointing at the target (i.e. it
        // was a linked child), but the target has already delinked it via
        // /new, reject the message so stale children can't inject traffic
        // into the parent's new conversation.
        if (senderSession.parentSessionId === targetSessionId) {
            const stillLinked = await isChildOfParent(targetSessionId, sessionId);
            if (!stillLinked) {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Sender is no longer a child of the target session (linked relationship is broken or stale)",
                });
                return;
            }
        }

        // Block stale parent→child traffic. deliverAs:"input" always
        // requires a live parent→child link (used by tell_child and
        // session_complete follow-up). Plain session_message (used by
        // send_message) is also blocked when the target's parentSessionId
        // still names the sender — the parent may have run /new and
        // delinked this child, so the old parent's plain messages must not
        // reach the child's brand-new conversation either.
        const isParentToChildTraffic = data.deliverAs === "input" || targetSession.parentSessionId === sessionId;
        if (isParentToChildTraffic) {
            const targetIsChild = await isChildOfParent(sessionId, targetSessionId);
            if (!targetIsChild) {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Target session is not a child of the sender (linked relationship is broken or stale)",
                });
                return;
            }
        }

        const targetSocket = getLocalTuiSocket(targetSessionId);
        if (targetSocket?.connected) {
            try {
                if (data.deliverAs === "input") {
                    // Deliver as agent input — starts a new turn (used by tell_child).
                    // Mirrors the viewer namespace "input" handler behavior.
                    targetSocket.emit("input" as string, {
                        text: messageText,
                        attachments: [],
                        client: "agent",
                        deliverAs: "followUp",
                    });
                } else {
                    // Deliver to message bus (used by send_message / wait_for_message).
                    targetSocket.emit("session_message" as string, {
                        fromSessionId: sessionId,
                        message: messageText,
                        ts: new Date().toISOString(),
                    });
                }
            } catch {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Failed to deliver message to target session",
                });
            }
        } else {
            // Cross-node fallback: target TUI socket is on a different server node.
            // Try to deliver via the relay room using verified cross-node emit.
            const eventName = data.deliverAs === "input" ? "input" : "session_message";
            const payload = data.deliverAs === "input"
                ? { text: messageText, attachments: [], client: "agent", deliverAs: "followUp" }
                : { fromSessionId: sessionId, message: messageText, ts: new Date().toISOString() };
            if (!await emitToRelaySessionVerified(targetSessionId, eventName, payload)) {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Target session not found or not connected",
                });
            }
        }
    });

    // ── session_trigger — child-to-parent trigger routing ────────────────
    socket.on("session_trigger", async (data) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId || data?.token !== socket.data.token) {
            socket.emit("error", { message: "Invalid token" });
            return;
        }

        const trigger = data?.trigger;
        if (!trigger?.targetSessionId || !trigger?.triggerId) {
            socket.emit("error", { message: "session_trigger requires trigger with targetSessionId and triggerId" });
            return;
        }

        const targetSessionId = trigger.targetSessionId;

        // Find the target session's relay socket and validate ownership
        const targetSession = await getSharedSession(targetSessionId);
        if (!targetSession) {
            socket.emit("session_message_error", {
                targetSessionId,
                error: `Target session ${targetSessionId} is not connected`,
            });
            return;
        }

        // Validate that the target session belongs to the same user
        const senderSession = await getSharedSession(sessionId);
        if (!senderSession?.userId || senderSession.userId !== targetSession.userId) {
            socket.emit("error", { message: "Target session belongs to a different user" });
            return;
        }

        if (targetSessionId !== sessionId && await isPendingParentDelinkChild(targetSessionId, sessionId)) {
            socket.emit("session_message_error", {
                targetSessionId,
                error: "Sender is currently being delinked from the target session",
            });
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
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Sender is no longer a child of the target session (linked relationship is broken or stale)",
                });
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
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Failed to deliver trigger to target session",
                });
            }
        } else if (await emitToRelaySessionVerified(targetSessionId, "session_trigger", { trigger })) {
            delivered = true;
        } else {
            // Cross-node fallback: target TUI socket is on a different server node.
            // emitToRelaySessionVerified returns false when no relay recipient is present.
            socket.emit("session_message_error", {
                targetSessionId,
                error: `Target session ${targetSessionId} is not connected`,
            });
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
        const senderSession = await getSharedSession(socket.data.sessionId);
        const targetSession = await getSharedSession(targetSessionId);

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
