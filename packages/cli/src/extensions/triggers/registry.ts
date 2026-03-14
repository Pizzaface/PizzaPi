// ============================================================================
// registry.ts — Hardcoded trigger renderers for the conversation trigger system
//
// Each renderer converts a structured ConversationTrigger into human-readable
// text for injection into a parent session's conversation, and optionally
// parses responses back into structured data.
// ============================================================================

import type { ConversationTrigger, TriggerRenderer } from "./types.js";

// ── Helper ──────────────────────────────────────────────────────────────────

function displayName(trigger: ConversationTrigger): string {
    return trigger.sourceSessionName ?? trigger.sourceSessionId.slice(0, 8);
}

function respondLine(triggerId: string): string {
    return `Respond with \`respond_to_trigger\` using trigger ID \`${triggerId}\`.`;
}

// ── Built-in renderers ──────────────────────────────────────────────────────

const askUserQuestionRenderer: TriggerRenderer = {
    type: "ask_user_question",
    render(trigger) {
        const name = displayName(trigger);
        const question = typeof trigger.payload.question === "string"
            ? trigger.payload.question
            : "No question provided";
        const options = Array.isArray(trigger.payload.options)
            ? (trigger.payload.options as string[])
            : [];

        const lines = [`🔗 Child "${name}" asks:`, `> ${question}`];
        if (options.length > 0) {
            lines.push(`Options: ${options.map((o, i) => `${i + 1}. ${o}`).join("  ")}`);
        }
        lines.push("", respondLine(trigger.triggerId));
        return lines.join("\n");
    },
    parseResponse(responseText) {
        return responseText;
    },
};

const planReviewRenderer: TriggerRenderer = {
    type: "plan_review",
    render(trigger) {
        const name = displayName(trigger);
        const title = typeof trigger.payload.title === "string"
            ? trigger.payload.title
            : "Untitled Plan";
        const steps = Array.isArray(trigger.payload.steps)
            ? (trigger.payload.steps as Array<{ title: string; description?: string }>)
            : [];
        const description = typeof trigger.payload.description === "string"
            ? trigger.payload.description
            : undefined;

        const lines = [`🔗 Child "${name}" submitted a plan for review:`, `## ${title}`];
        if (description) {
            lines.push("", description);
        }
        if (steps.length > 0) {
            lines.push("");
            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                lines.push(`${i + 1}. ${step.title}`);
                if (step.description) {
                    lines.push(`   ${step.description}`);
                }
            }
        }
        lines.push("", respondLine(trigger.triggerId));
        lines.push(`Use respond_to_trigger with action: "approve" to accept, "cancel" to reject, or "edit" with feedback.`);
        return lines.join("\n");
    },
    parseResponse(responseText) {
        const lower = responseText.toLowerCase().trim();
        const approvalWords = ["begin", "approve", "approved", "lgtm", "looks good", "proceed"];
        const cancelWords = ["cancel", "stop", "reject", "no"];

        if (approvalWords.some((w) => lower === w || lower.startsWith(w + " "))) {
            return { action: "approve" };
        }
        if (cancelWords.some((w) => lower === w || lower.startsWith(w + " "))) {
            return { action: "cancel" };
        }
        return { action: "edit", feedback: responseText };
    },
};

const sessionCompleteRenderer: TriggerRenderer = {
    type: "session_complete",
    render(trigger) {
        const name = displayName(trigger);
        const summary = typeof trigger.payload.summary === "string"
            ? trigger.payload.summary
            : "No summary provided.";

        return [
            `🔗 Child "${name}" completed:`,
            summary,
            "",
            respondLine(trigger.triggerId),
            `Use respond_to_trigger with action: "ack" to acknowledge, or action: "followUp" with instructions to resume the child.`,
        ].join("\n");
    },
    parseResponse(responseText) {
        const lower = responseText.toLowerCase().trim().replace(/[!.,]+$/, "");
        const ackWords = ["ok", "ack", "thanks", "noted", "lgtm", "acknowledged", "got it"];
        if (ackWords.some((w) => lower === w || lower.startsWith(w + " "))) {
            return { action: "ack" };
        }
        return { action: "followUp", message: responseText };
    },
};

const sessionErrorRenderer: TriggerRenderer = {
    type: "session_error",
    render(trigger) {
        const name = displayName(trigger);
        const message = typeof trigger.payload.message === "string"
            ? trigger.payload.message
            : typeof trigger.payload.error === "string"
                ? trigger.payload.error
                : "Unknown error.";

        return [
            `⚠️ Child "${name}" encountered an error:`,
            message,
            "",
            respondLine(trigger.triggerId),
        ].join("\n");
    },
    parseResponse(responseText) {
        return responseText;
    },
};

const escalateRenderer: TriggerRenderer = {
    type: "escalate",
    render(trigger) {
        const name = displayName(trigger);
        const reason = typeof trigger.payload.reason === "string"
            ? trigger.payload.reason
            : "No reason provided.";

        return [
            `🚨 Trigger escalated from child "${name}":`,
            reason,
            "",
            `This requires human attention. ${respondLine(trigger.triggerId)}`,
        ].join("\n");
    },
    parseResponse(responseText) {
        return responseText;
    },
};

// ── Registry ────────────────────────────────────────────────────────────────

export const TRIGGER_RENDERERS: ReadonlyMap<string, TriggerRenderer> = new Map([
    ["ask_user_question", askUserQuestionRenderer],
    ["plan_review", planReviewRenderer],
    ["session_complete", sessionCompleteRenderer],
    ["session_error", sessionErrorRenderer],
    ["escalate", escalateRenderer],
]);

/** Render a trigger to text, with trigger ID metadata prefix. */
export function renderTrigger(trigger: ConversationTrigger): string {
    const renderer = TRIGGER_RENDERERS.get(trigger.type);
    const body = renderer
        ? renderer.render(trigger)
        : `🔗 Child "${displayName(trigger)}" sent unknown trigger "${trigger.type}". Payload: ${JSON.stringify(trigger.payload)}`;
    return `<!-- trigger:${trigger.triggerId} -->\n${body}`;
}

/** Parse a response using the trigger type's parser, if available. */
export function parseTriggerResponse(trigger: ConversationTrigger, responseText: string): unknown {
    const renderer = TRIGGER_RENDERERS.get(trigger.type);
    return renderer?.parseResponse?.(responseText, trigger) ?? responseText;
}
