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
    AskUserQuestionType,
    AskUserQuestionDisplay,
    AskUserQuestionDetails,
} from "./remote-types.js";
import { emitQuestionPending, emitQuestionCleared } from "./remote-meta-events.js";

const ASK_USER_TOOL_NAME = "AskUserQuestion";

// ── ANSI helpers (module-level so exported display fns can use them) ─────────

const _P  = "\x1b[38;2;196;167;224m"; // border soft purple
const _Ac = "\x1b[38;2;232;180;248m"; // accent plum
const _RF = "\x1b[39m";               // reset fg color
const _bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const _dim  = (s: string) => `\x1b[2m${s}\x1b[22m`;
const _clrP = (s: string) => `${_P}${s}${_RF}`;
const _clrA = (s: string) => `${_Ac}${s}${_RF}`;

// ── Pure display helpers (exported for testing) ──────────────────────────────

/** The visible character width of the box interior (between │ borders). */
export const BOX_W = 58;

/** Return the visual column width of a Unicode code point (1 for narrow, 2 for wide). */
function _cpWidth(cp: number): number {
    return (
        (cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
        (cp >= 0x2E80 && cp <= 0x303E) ||   // CJK Radicals Supplement … CJK Symbols
        (cp >= 0x3040 && cp <= 0x33FF) ||   // Hiragana, Katakana, Bopomofo, CJK
        (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Extension A
        (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs
        (cp >= 0xA000 && cp <= 0xA4CF) ||   // Yi
        (cp >= 0xAC00 && cp <= 0xD7AF) ||   // Hangul Syllables
        (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility Ideographs
        (cp >= 0xFE10 && cp <= 0xFE19) ||   // Vertical Forms
        (cp >= 0xFE30 && cp <= 0xFE4F) ||   // CJK Compatibility Forms
        (cp >= 0xFF00 && cp <= 0xFF60) ||   // Fullwidth Latin / Halfwidth Katakana
        (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // Fullwidth Signs
        (cp >= 0x1F300 && cp <= 0x1F9FF) || // Misc Symbols, Emoji
        (cp >= 0x20000 && cp <= 0x2A6DF) || // CJK Extension B
        (cp >= 0x2A700 && cp <= 0x2CEAF) || // CJK Extension C–E
        (cp >= 0x2CEB0 && cp <= 0x2EBEF) || // CJK Extension F
        (cp >= 0x30000 && cp <= 0x3134F)    // CJK Extension G
    ) ? 2 : 1;
}

/**
 * Strip ANSI escape sequences and measure visual display width.
 * Wide characters (CJK, most emoji) count as 2 columns.
 */
export function visLen(s: string): number {
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
    let width = 0;
    for (const char of stripped) {
        const cp = char.codePointAt(0) ?? 0;
        width += _cpWidth(cp);
    }
    return width;
}

/**
 * Pad a styled string to exactly BOX_W visible columns.
 * When content already meets or exceeds BOX_W, no padding is added (border will
 * still be placed immediately after — callers must pre-wrap long content).
 */
export function padTo(s: string): string {
    return s + " ".repeat(Math.max(0, BOX_W - visLen(s)));
}

/**
 * Wrap plain text (no ANSI) into lines that each fit within `maxWidth` visible
 * columns.  Word-wraps at spaces; hard-truncates tokens that are individually
 * wider than `maxWidth`.
 */
export function wrapText(text: string, maxWidth: number): string[] {
    if (maxWidth <= 0) return [text];
    if (visLen(text) <= maxWidth) return [text];

    const words = text.split(" ");
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (visLen(candidate) <= maxWidth) {
            current = candidate;
        } else {
            if (current) lines.push(current);
            if (visLen(word) > maxWidth) {
                // Hard-truncate a single token that is too wide on its own
                let truncated = "";
                for (const char of word) {
                    if (visLen(truncated + char) > maxWidth - 1) break;
                    truncated += char;
                }
                lines.push(truncated + "…");
                current = "";
            } else {
                current = word;
            }
        }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [text];
}

/** Wrap a box content row with purple border characters. */
export function bRow(inner: string): string {
    return _clrP("│") + inner + _clrP("│");
}

/** Return the type-hint label for a question's selection mode. */
export function typeLabel(type: AskUserQuestionType | undefined): string {
    return type === "checkbox" ? "[select multiple]"
         : type === "ranked"   ? "[rank in order]"
         : "[select one]";
}

/**
 * Build the branded TUI box for a single question.
 *
 * @param q              The question item (question text + options + optional type).
 * @param idx            Zero-based index of this question in the batch.
 * @param totalQuestions Total number of questions in the batch (used for "Q1 of N" header).
 */
export function buildBox(q: AskUserQuestionItem, idx: number, totalQuestions: number): string {
    const rows: string[] = [];
    const emptyRow = bRow(" ".repeat(BOX_W));

    // ── Header ──────────────────────────────────────────────────────────────
    const hdr       = " AskUserQuestion ";
    const hdrDashes = "─".repeat(Math.max(0, BOX_W - 1 - hdr.length));
    rows.push(_clrP(`╭─${hdr}${hdrDashes}╮`));
    rows.push(emptyRow);

    // ── Step counter + type hint ─────────────────────────────────────────────
    const step = totalQuestions > 1 ? `  Q${idx + 1} of ${totalQuestions}: ` : "  ";
    rows.push(bRow(padTo(_dim(`${step}${typeLabel(q.type)}`))));

    // ── Question text (bold, word-wrapped) ───────────────────────────────────
    const qPrefix = "  ";
    const maxQWidth = BOX_W - qPrefix.length;
    for (const line of wrapText(q.question, maxQWidth)) {
        rows.push(bRow(padTo(`${qPrefix}${_bold(line)}`)));
    }

    // ── Numbered options (word-wrapped) ──────────────────────────────────────
    if (q.options.length > 0) {
        rows.push(emptyRow);
        for (let j = 0; j < q.options.length; j++) {
            const numLabel  = `(${j + 1})`;
            const optPrefix = `  ${numLabel} `;          // "  (1) "  or "  (10) "
            const indent    = " ".repeat(visLen(optPrefix));
            const maxOptW   = BOX_W - visLen(optPrefix);
            const optLines  = wrapText(q.options[j], maxOptW);

            // First wrapped line carries the coloured label
            rows.push(bRow(padTo(`  ${_clrA(numLabel)} ${optLines[0]}`)));
            // Continuation lines are indented to align under the option text
            for (let k = 1; k < optLines.length; k++) {
                rows.push(bRow(padTo(indent + optLines[k])));
            }
        }
    }

    rows.push(emptyRow);
    rows.push(_clrP(`╰${"─".repeat(BOX_W)}╯`));
    return rows.join("\n");
}

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
            const rawType = raw.type;
            const type: AskUserQuestionType | undefined =
                rawType === "checkbox" ? "checkbox" : rawType === "ranked" ? "ranked" : rawType === "radio" ? "radio" : undefined;
            result.push({ question: q.trim(), options: opts, ...(type ? { type } : {}) });
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
    const clearedToolCallId = pending.toolCallId;
    rctx.pendingAskUserQuestion = null;
    emitQuestionCleared(rctx, clearedToolCallId);
    pending.resolve(answer);
    rctx.setRelayStatus(rctx.relay ? "Connected to Relay" : rctx.disconnectedStatusText());
    return true;
}

export function cancelPendingAskUserQuestion(rctx: RelayContext) {
    if (!rctx.pendingAskUserQuestion) return;
    const pending = rctx.pendingAskUserQuestion;
    const clearedToolCallId = pending.toolCallId;
    rctx.pendingAskUserQuestion = null;
    emitQuestionCleared(rctx, clearedToolCallId);
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
                emitQuestionCleared(rctx, toolCallId);
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
            emitQuestionPending(rctx, {
                toolCallId: rctx.pendingAskUserQuestion.toolCallId,
                questions: rctx.pendingAskUserQuestion.questions,
                display: rctx.pendingAskUserQuestion.display,
            });
            rctx.setRelayStatus("Waiting for AskUserQuestion answer");
        }

        if (canAskViaTui) {
            const displayQuestion = questions
                .map((q, i) => buildBox(q, i, questions.length))
                .join("\n\n");

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
                            type: {
                                type: "string",
                                enum: ["radio", "checkbox", "ranked"],
                                description: "Selection mode. \"radio\" (default) for single-select, \"checkbox\" for multi-select, \"ranked\" for ranked-choice ordering.",
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
