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
        const fullOutputPath = typeof trigger.payload.fullOutputPath === "string"
            ? trigger.payload.fullOutputPath
            : null;
        const exitReason = typeof trigger.payload.exitReason === "string"
            ? trigger.payload.exitReason as "completed" | "killed" | "error"
            : "completed";

        const verb = exitReason === "killed" ? "was killed"
            : exitReason === "error" ? "errored"
            : "completed";
        const lines = [
            `🔗 Child "${name}" ${verb}:`,
            `Exit reason: ${exitReason}`,
            `---`,
            summary,
        ];
        if (fullOutputPath) {
            lines.push("", `📄 Full output saved to: ${fullOutputPath}`, `(Use the Read tool to access the complete output if the above is insufficient.)`);
        }
        lines.push(
            "",
            respondLine(trigger.triggerId),
            `Use respond_to_trigger with action: "ack" to acknowledge completion, or action: "followUp" with instructions to send the child more work.`,
        );
        return lines.join("\n");
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

const externalRenderer: TriggerRenderer = {
    type: "external",
    render(trigger) {
        const source = trigger.sourceSessionName ?? trigger.sourceSessionId;
        const summary = typeof trigger.payload.summary === "string"
            ? trigger.payload.summary
            : undefined;
        const type = typeof trigger.payload.eventType === "string"
            ? trigger.payload.eventType
            : trigger.type;

        const lines = [`🌐 External trigger from ${source}:`];
        if (summary) {
            lines.push(`> ${summary}`);
        }
        lines.push(`Type: ${type}`);
        // Surface the webhook prompt (instructions) prominently when present.
        const prompt = typeof trigger.payload.prompt === "string" ? trigger.payload.prompt : undefined;
        if (prompt) {
            lines.push("", `**Prompt:** ${prompt}`);
        }
        // Include payload data so the agent can act on the trigger content.
        // Filter out keys already rendered above (summary, eventType, prompt).
        const dataPayload = Object.fromEntries(
            Object.entries(trigger.payload).filter(([k]) => k !== "summary" && k !== "eventType" && k !== "prompt"),
        );
        if (Object.keys(dataPayload).length > 0) {
            lines.push("", "```json", JSON.stringify(dataPayload, null, 2), "```");
        }
        if (trigger.expectsResponse) {
            lines.push("", respondLine(trigger.triggerId));
        }
        return lines.join("\n");
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
    ["external", externalRenderer],
    ["webhook", externalRenderer],
    ["service", externalRenderer],
    ["cron", externalRenderer],
    ["custom", externalRenderer],
]);

/**
 * Render multiple triggers that arrived in the same batch window into a single
 * message. When only one trigger is in the batch the output is identical to
 * `renderTrigger`. For multiple triggers each is rendered individually and the
 * results are joined with a separator so the parent agent sees them all at once.
 */
export function renderTriggerBatch(triggers: ConversationTrigger[]): string {
    if (triggers.length === 1) return renderTrigger(triggers[0]);
    const parts = triggers.map((t) => renderTrigger(t));
    return `🔗 ${triggers.length} child triggers arrived simultaneously:\n\n` + parts.join("\n\n---\n\n");
}

/** Render a trigger to text, with trigger ID metadata prefix. */
export function renderTrigger(trigger: ConversationTrigger): string {
    const renderer = TRIGGER_RENDERERS.get(trigger.type);
    const body = renderer
        ? renderer.render(trigger)
        : `🔗 Child "${displayName(trigger)}" sent unknown trigger "${trigger.type}". Payload: ${JSON.stringify(trigger.payload)}`;

    // Embed structured questions as base64 inside the trigger metadata comment
    // so the web UI can render rich multi-question / checkbox / ranked triggers
    // without polluting the agent-facing prompt text with a separate comment.
    const questions = trigger.type === "ask_user_question" && Array.isArray(trigger.payload.questions)
        ? trigger.payload.questions
        : undefined;
    const q64 = questions
        ? ` questions64:${Buffer.from(JSON.stringify(questions), "utf-8").toString("base64")}`
        : "";
    return `<!-- trigger:${trigger.triggerId} source:${trigger.sourceSessionId}${q64} -->\n${body}`;
}

/** Parse a response using the trigger type's parser, if available. */
export function parseTriggerResponse(trigger: ConversationTrigger, responseText: string): unknown {
    const renderer = TRIGGER_RENDERERS.get(trigger.type);
    return renderer?.parseResponse?.(responseText, trigger) ?? responseText;
}
