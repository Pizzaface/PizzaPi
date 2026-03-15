/**
 * AskUserQuestion tool for the remote extension.
 *
 * Handles the dual TUI/web race and child-session trigger routing.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
    RelayContext,
    AskUserQuestionParams,
    AskUserQuestionItem,
    AskUserQuestionDisplay,
    AskUserQuestionDetails,
} from "./remote-types.js";

const ASK_USER_TOOL_NAME = "AskUserQuestion";

// ── Pure sanitization helpers ────────────────────────────────────────────────

/** Defensively sanitize questions from params (supports new + legacy format). */
export function sanitizeQuestions(params: AskUserQuestionParams): AskUserQuestionItem[] {
    // New format: questions[]
    if (Array.isArray(params.questions) && params.questions.length > 0) {
        const result: AskUserQuestionItem[] = [];
        for (const item of params.questions) {
            if (!item || typeof item !== "object") continue;
            const raw = item as unknown as Record<string, unknown>;
            const q = raw.question;
            if (typeof q !== "string" || !q.trim()) continue;
            const rawOpts = raw.options;
            const opts = Array.isArray(rawOpts)
                ? rawOpts.filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
                : [];
            result.push({ question: q.trim(), options: opts });
        }
        if (result.length > 0) return result;
    }
    // Legacy format: single question + options
    if (typeof params.question === "string" && params.question.trim()) {
        const opts = Array.isArray(params.options)
            ? params.options.filter((o): o is string => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
            : [];
        return [{ question: params.question.trim(), options: opts }];
    }
    return [];
}

export function sanitizeDisplay(_rawDisplay: unknown): AskUserQuestionDisplay {
    return "stepper";
}

// ── Pending question management ──────────────────────────────────────────────

export function consumePendingAskUserQuestionFromWeb(rctx: RelayContext, text: string): boolean {
    if (!rctx.pendingAskUserQuestion) return false;
    const answer = text.trim();
    if (!answer) return true;

    const pending = rctx.pendingAskUserQuestion;
    rctx.pendingAskUserQuestion = null;
    pending.resolve(answer);
    rctx.setRelayStatus(rctx.relay ? "Connected to Relay" : rctx.disconnectedStatusText());
    return true;
}

export function cancelPendingAskUserQuestion(rctx: RelayContext) {
    if (!rctx.pendingAskUserQuestion) return;
    const pending = rctx.pendingAskUserQuestion;
    rctx.pendingAskUserQuestion = null;
    pending.resolve(null);
    rctx.setRelayStatus(rctx.relay ? "Connected to Relay" : rctx.disconnectedStatusText());
}

// ── Dual TUI/web race ────────────────────────────────────────────────────────

async function askUserQuestion(
    rctx: RelayContext,
    toolCallId: string,
    questions: AskUserQuestionItem[],
    display: AskUserQuestionDisplay,
    placeholder: string | undefined,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
): Promise<{ answer: string | null; source: "tui" | "web" | null }> {
    const canAskViaWeb = rctx.isConnected();
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

            if (rctx.pendingAskUserQuestion?.toolCallId === toolCallId) {
                rctx.pendingAskUserQuestion = null;
            }

            localAbort.abort();
            if (signal) signal.removeEventListener("abort", onAbort);
            rctx.setRelayStatus(rctx.relay ? "Connected to Relay" : rctx.disconnectedStatusText());
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
            rctx.pendingAskUserQuestion = {
                toolCallId,
                questions,
                display,
                resolve: (answer) => {
                    webDone = true;
                    if (answer) {
                        finish(answer, "web");
                    } else {
                        maybeFinishCancelled();
                    }
                },
            };
            rctx.setRelayStatus("Waiting for AskUserQuestion answer");
        }

        if (canAskViaTui) {
            const displayParts = questions.map((q, i) => {
                let text = questions.length > 1 ? `Q${i + 1}: ${q.question}` : q.question;
                if (q.options.length > 0) {
                    text += ` (Options: ${q.options.join(", ")})`;
                }
                return text;
            });
            const displayQuestion = displayParts.join("\n");

            void ctx.ui
                .input(displayQuestion, placeholder, { signal: localAbort.signal })
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

// ── Tool registration ────────────────────────────────────────────────────────

export function registerAskUserTool(rctx: RelayContext) {
    rctx.pi.registerTool({
        name: ASK_USER_TOOL_NAME,
        label: "Ask User Question",
        description:
            "Ask the user one or more multiple-choice questions and wait for responses. Use this when you must collect user input before continuing.",
        parameters: {
            type: "object",
            properties: {
                questions: {
                    type: "array",
                    description: "One or more questions to ask. Each must include options for the user to choose from.",
                    items: {
                        type: "object",
                        properties: {
                            question: {
                                type: "string",
                                description: "The question text.",
                            },
                            options: {
                                type: "array",
                                items: { type: "string" },
                                description: "Predefined choices for the user to select from. The UI will automatically add a \"Write your own...\" free-form option.",
                            },
                        },
                        required: ["question", "options"],
                    },
                },
                display: {
                    type: "string",
                    enum: ["stepper"],
                    description: "Optional UI layout hint. Only `stepper` is supported.",
                },
                question: {
                    type: "string",
                    description: "(Legacy) The question to ask the user. Prefer `questions` array.",
                },
                placeholder: {
                    type: "string",
                    description: "(Legacy) Optional placeholder hint.",
                },
                options: {
                    type: "array",
                    items: { type: "string" },
                    description: "(Legacy) Predefined choices. Prefer `questions` array.",
                },
            },
            additionalProperties: false,
        } as any,
        async execute(toolCallId: string, rawParams: any, signal: any, onUpdate: any, ctx: any) {
            if (rctx.pendingAskUserQuestion && rctx.pendingAskUserQuestion.toolCallId !== toolCallId) {
                return {
                    content: [{ type: "text", text: "A different AskUserQuestion prompt is already pending." }],
                    details: {
                        questions: rctx.pendingAskUserQuestion.questions,
                        display: rctx.pendingAskUserQuestion.display,
                        answers: null,
                        answer: null,
                        source: null,
                        cancelled: true,
                    } satisfies AskUserQuestionDetails,
                };
            }

            const params = (rawParams ?? {}) as AskUserQuestionParams;
            const questions = sanitizeQuestions(params);
            const display = sanitizeDisplay(params.display);

            if (questions.length === 0 || !questions.some(q => q.question.trim())) {
                return {
                    content: [{ type: "text", text: "AskUserQuestion requires at least one non-empty question." }],
                    details: {
                        questions: [],
                        display,
                        answers: null,
                        answer: null,
                        source: null,
                        cancelled: true,
                    } satisfies AskUserQuestionDetails,
                };
            }

            // ── Child session: fire trigger to parent instead of waiting for web/TUI ──
            if (rctx.isChildSession && rctx.parentSessionId && rctx.isConnected()) {
                const triggerId = randomUUID();
                const trigger = {
                    type: "ask_user_question" as const,
                    sourceSessionId: rctx.relaySessionId,
                    sourceSessionName: rctx.getCurrentSessionName() ?? rctx.relaySessionId.slice(0, 8),
                    targetSessionId: rctx.parentSessionId,
                    payload: {
                        question: questions.map(q => q.question).join("; "),
                        options: questions.flatMap(q => q.options),
                        questions,
                    },
                    deliverAs: "followUp" as const,
                    expectsResponse: true,
                    triggerId,
                    timeoutMs: 300_000,
                    ts: new Date().toISOString(),
                };

                rctx.emitTrigger(trigger as any);

                const triggerResult = await rctx.waitForTriggerResponse(triggerId, trigger.timeoutMs, signal);

                return {
                    content: [{ type: "text", text: triggerResult.response }],
                    details: {
                        questions,
                        display,
                        answers: null,
                        answer: triggerResult.cancelled ? null : triggerResult.response,
                        source: "parent_trigger" as any,
                        cancelled: triggerResult.cancelled ?? false,
                    } satisfies AskUserQuestionDetails,
                };
            }

            const summaryText = questions.map(q => q.question).join("; ");
            onUpdate?.({
                content: [{ type: "text", text: `Waiting for answer: ${summaryText}` }],
                details: {
                    questions,
                    display,
                    answers: null,
                    answer: null,
                    source: null,
                    cancelled: false,
                    status: "waiting",
                } satisfies AskUserQuestionDetails,
            });

            const result = await askUserQuestion(
                rctx,
                toolCallId,
                questions,
                display,
                typeof params.placeholder === "string" ? params.placeholder : undefined,
                signal,
                ctx,
            );

            if (!result.answer) {
                return {
                    content: [{ type: "text", text: "User did not provide an answer." }],
                    details: {
                        questions,
                        display,
                        answers: null,
                        answer: null,
                        source: null,
                        cancelled: true,
                    } satisfies AskUserQuestionDetails,
                };
            }

            // Try to parse structured answers from web UI (JSON object)
            let parsedAnswers: Record<string, string> | null = null;
            try {
                const parsed = JSON.parse(result.answer);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    const entries = Object.entries(parsed);
                    if (entries.every(([k, v]) => typeof k === "string" && typeof v === "string")) {
                        parsedAnswers = parsed as Record<string, string>;
                    }
                }
            } catch {
                // TUI or plain text answer
            }

            onUpdate?.({
                content: [{ type: "text", text: `Answer received: ${result.answer}` }],
                details: {
                    questions,
                    display,
                    answers: parsedAnswers,
                    answer: result.answer,
                    source: result.source,
                    cancelled: false,
                    status: "answered",
                } satisfies AskUserQuestionDetails,
            });

            return {
                content: [{ type: "text", text: `User answered: ${result.answer}` }],
                details: {
                    questions,
                    display,
                    answers: parsedAnswers,
                    answer: result.answer,
                    source: result.source,
                    cancelled: false,
                } satisfies AskUserQuestionDetails,
            };
        },
    });
}
