// ── Push notification checks ─────────────────────────────────────────────────

import {
    setPushPendingQuestion,
    clearPushPendingQuestion,
    isLinkedChildForSuppression,
} from "../../sio-state.js";
import {
    notifyAgentFinished,
    notifyAgentNeedsInput,
    notifyAgentError,
} from "../../../push.js";
import { getSharedSession, getViewerCount } from "../../sio-registry.js";

/**
 * Manage the push-pending Redis key for AskUserQuestion lifecycle.
 * Awaited only for AskUserQuestion start/end events to avoid
 * blocking the hot relay path for high-frequency events.
 */
export async function trackPushPendingState(
    sessionId: string,
    event: Record<string, unknown>,
): Promise<void> {
    if (event.type === "tool_execution_start" && event.toolName === "AskUserQuestion") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (toolCallId) {
            await setPushPendingQuestion(sessionId, toolCallId);
        }
    }
    if (event.type === "tool_execution_end" && event.toolName === "AskUserQuestion") {
        // Pass toolCallId so only the matching key is cleared — prevents a
        // cancelled/overlapping AskUserQuestion from clearing the active one.
        const endToolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        await clearPushPendingQuestion(sessionId, endToolCallId);
    }
}

export async function checkPushNotifications(
    sessionId: string,
    event: Record<string, unknown>,
): Promise<void> {
    // ⚡ Bolt: Fast synchronous check to bypass expensive Redis operations (getSharedSession/getViewerCount)
    // for high-frequency stream events (like text deltas) that don't trigger push notifications.
    if (
        event.type !== "agent_end" &&
        event.type !== "cli_error" &&
        !(event.type === "tool_execution_start" && event.toolName === "AskUserQuestion")
    ) {
        return;
    }

    const session = await getSharedSession(sessionId);
    const userId = session?.userId;
    if (!userId) return;

    const viewerCount = await getViewerCount(sessionId);
    if (viewerCount > 0) return;

    const sName = session?.sessionName ?? null;

    // Determine whether this session is an active linked child for push-suppression.
    //
    // Use linkedParentId as the stable parent reference (persists through transient
    // parent outages; cleared only on explicit delink). Fall back to parentSessionId
    // for sessions registered before this field was added.
    //
    // isLinkedChildForSuppression is purpose-built for suppression decisions:
    //   • Explicit delink → false (delink marker check)
    //   • Membership set present → true (parent online or temporarily offline)
    //   • Set miss → falls back to parent-key existence (bounds suppression to
    //     SESSION_TTL_SECONDS after a parent crash, without re-hydrating the set)
    //
    // isChildOfParent is intentionally NOT used here: its TTL-recovery fallback
    // re-hydrates the membership set from the child's parentSessionId hash field,
    // which would break when parentSessionId is null (offline-reconnect path) and
    // would extend suppression beyond the parent-key TTL.
    const effectiveParentId = session?.linkedParentId ?? session?.parentSessionId ?? null;
    const isChildSession = !!effectiveParentId && await isLinkedChildForSuppression(effectiveParentId, sessionId);

    if (event.type === "agent_end") {
        notifyAgentFinished(userId, sessionId, sName, isChildSession);
    }

    if (event.type === "tool_execution_start" && event.toolName === "AskUserQuestion") {
        const args = event.args as Record<string, unknown> | undefined;
        // Extract first question text and options: try questions[] format, fall back to legacy.
        // Only include quick-reply options for single-question prompts — multi-question
        // prompts require the full UI since a push reply can only carry one answer.
        let question: string | undefined;
        let options: string[] | undefined;
        let questionCount = 0;
        if (Array.isArray(args?.questions)) {
            for (const q of args!.questions as unknown[]) {
                if (q && typeof q === "object" && typeof (q as any).question === "string" && (q as any).question.trim()) {
                    questionCount++;
                    if (!question) {
                        question = ((q as any).question as string).trim();
                        if (Array.isArray((q as any).options)) {
                            options = ((q as any).options as unknown[]).filter((o): o is string => typeof o === "string" && o.trim().length > 0);
                        }
                    }
                }
            }
        }
        if (!question && typeof args?.question === "string" && args.question.trim()) {
            question = (args.question as string).trim();
            questionCount = 1;
            if (Array.isArray(args?.options)) {
                options = (args.options as unknown[]).filter((o): o is string => typeof o === "string" && o.trim().length > 0);
            }
        }
        // Quick-reply actions require: single question + collab mode + toolCallId.
        // Multi-question prompts need the full UI; non-collab sessions reject
        // push answers with 403; missing toolCallId means /api/push/answer will
        // reject with 400 — so don't show action buttons in any of those cases.
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        const canQuickReply = questionCount <= 1 && session?.collabMode === true && !!toolCallId;
        notifyAgentNeedsInput(userId, sessionId, question, sName, canQuickReply ? options : undefined, toolCallId, isChildSession);
    }

    if (event.type === "cli_error") {
        const errMsg = typeof event.message === "string" ? event.message : undefined;
        notifyAgentError(userId, sessionId, errMsg, sName, isChildSession);
    }
}
