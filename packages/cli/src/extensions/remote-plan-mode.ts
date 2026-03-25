/**
 * plan_mode tool for the remote extension.
 *
 * Handles the dual TUI/web race and child-session trigger routing.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { setPlanModeFromRemote, requestContextClear } from "./plan-mode-toggle.js";
import type {
    RelayContext,
    PlanModeParams,
    PlanModeStep,
    PlanModeAction,
    PlanModeDetails,
} from "./remote-types.js";
import { emitPlanPending, emitPlanCleared } from "./remote-meta-events.js";

const PLAN_MODE_TOOL_NAME = "plan_mode";

// ── Exported pure helpers (testable at module scope) ─────────────────────────

/** Visible display width — strips ANSI escape codes and counts wide (astral) chars as 2. */
export const vlen = (s: string): number => {
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
    let len = 0;
    for (const ch of stripped) {
        len += (ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
    }
    return len;
};

/**
 * Split a single word into chunks that are each at most maxWidth characters.
 * Used internally by wrap() to prevent single words from silently overflowing.
 */
const splitLongWord = (word: string, maxWidth: number): string[] => {
    if (word.length <= maxWidth) return [word];
    const chunks: string[] = [];
    let i = 0;
    while (i < word.length) {
        chunks.push(word.slice(i, i + maxWidth));
        i += maxWidth;
    }
    return chunks;
};

/**
 * Word-wrap plain text at maxWidth characters.
 * Words that individually exceed maxWidth are split into fixed-width chunks
 * so they never silently overflow the box border.
 */
export const wrap = (text: string, maxWidth: number): string[] => {
    if (maxWidth <= 0) return [text];
    const words = text.split(" ");
    const out: string[] = [];
    let cur = "";
    for (const word of words) {
        // Split any word that is wider than the column before fitting
        const parts = word.length > maxWidth ? splitLongWord(word, maxWidth) : [word];
        for (const part of parts) {
            if (!cur) { cur = part; continue; }
            if (cur.length + 1 + part.length <= maxWidth) { cur += " " + part; }
            else { out.push(cur); cur = part; }
        }
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
};

/**
 * Compute the inner content width for the plan-mode box.
 *
 * Grows with the title up to a hard cap of min(termCols − 4, 120) so the box
 * never overflows the terminal on long titles or wide displays.
 *
 * @param titleLen  Length of the plan title (used as a sizing hint).
 * @param termCols  Terminal column count (defaults to process.stdout.columns or 80).
 */
export const computeBoxWidth = (titleLen: number, termCols?: number): number => {
    const cols = termCols ?? (process.stdout.columns || 80);
    const upper = Math.min(cols - 4, 120);
    return Math.max(62, Math.min(titleLen + 16, upper));
};

/**
 * Build a two-column option row for the action-choice footer.
 *
 * @param o1        Left option string (may contain ANSI escapes).
 * @param o2        Right option string (may contain ANSI escapes).
 * @param col1Width Target visible width for the left column (default 30).
 */
export const makeOptRow = (o1: string, o2: string, col1Width = 30): string => {
    const gap = " ".repeat(Math.max(2, col1Width - vlen(o1)));
    return "  " + o1 + gap + o2;
};

// ── Pending plan mode management ─────────────────────────────────────────────

export function consumePendingPlanModeFromWeb(rctx: RelayContext, text: string): boolean {
    if (!rctx.pendingPlanMode) return false;
    const trimmed = text.trim();
    if (!trimmed) return true;

    let response: { action: PlanModeAction; editSuggestion?: string } | null = null;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
            const validActions: PlanModeAction[] = ["execute", "execute_keep_context", "edit", "cancel"];
            if (validActions.includes(parsed.action)) {
                response = {
                    action: parsed.action,
                    editSuggestion: typeof parsed.editSuggestion === "string" ? parsed.editSuggestion : undefined,
                };
            }
        }
    } catch {
        response = { action: "edit", editSuggestion: trimmed };
    }

    if (!response) return true;

    const pending = rctx.pendingPlanMode;
    const clearedToolCallId = pending.toolCallId;
    rctx.pendingPlanMode = null;
    emitPlanCleared(rctx, clearedToolCallId);
    pending.resolve(response);
    rctx.setRelayStatus(rctx.relay ? "Connected to Relay" : rctx.disconnectedStatusText());
    return true;
}

export function cancelPendingPlanMode(rctx: RelayContext) {
    if (!rctx.pendingPlanMode) return;
    const pending = rctx.pendingPlanMode;
    const clearedToolCallId = pending.toolCallId;
    rctx.pendingPlanMode = null;
    emitPlanCleared(rctx, clearedToolCallId);
    pending.resolve(null);
    rctx.setRelayStatus(rctx.relay ? "Connected to Relay" : rctx.disconnectedStatusText());
}

// ── Dual TUI/web race ────────────────────────────────────────────────────────

async function askPlanMode(
    rctx: RelayContext,
    toolCallId: string,
    title: string,
    description: string | null,
    steps: PlanModeStep[],
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
): Promise<{ action: PlanModeAction; editSuggestion?: string } | null> {
    const canAskViaWeb = rctx.isConnected();
    const canAskViaTui = ctx.hasUI;

    if (!canAskViaWeb && !canAskViaTui) {
        return null;
    }

    const localAbort = new AbortController();

    return await new Promise((resolve) => {
        let finished = false;
        let localDone = !canAskViaTui;
        let webDone = !canAskViaWeb;

        const onAbort = () => finish(null);

        const maybeFinishCancelled = () => {
            if (localDone && webDone) finish(null);
        };

        const finish = (response: { action: PlanModeAction; editSuggestion?: string } | null) => {
            if (finished) return;
            finished = true;

            if (rctx.pendingPlanMode?.toolCallId === toolCallId) {
                rctx.pendingPlanMode = null;
                emitPlanCleared(rctx, toolCallId);
            }

            localAbort.abort();
            if (signal) signal.removeEventListener("abort", onAbort);
            rctx.setRelayStatus(rctx.relay ? "Connected to Relay" : rctx.disconnectedStatusText());
            resolve(response);
        };

        if (signal?.aborted) {
            finish(null);
            return;
        }

        if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
        }

        if (canAskViaWeb) {
            rctx.pendingPlanMode = {
                toolCallId,
                title,
                description,
                steps,
                resolve: (response) => {
                    webDone = true;
                    if (response) {
                        finish(response);
                    } else {
                        maybeFinishCancelled();
                    }
                },
            };
            emitPlanPending(rctx, {
                toolCallId: rctx.pendingPlanMode.toolCallId,
                title: rctx.pendingPlanMode.title,
                description: rctx.pendingPlanMode.description,
                steps: rctx.pendingPlanMode.steps,
            });
            rctx.setRelayStatus("Waiting for plan review");
        }

        if (canAskViaTui) {
            // ── ANSI style helpers ──────────────────────────────────────────
            const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
            const accent = (s: string) => `\x1b[38;2;232;180;248m${s}\x1b[39m`;
            const dimText = (s: string) => `\x1b[2m${s}\x1b[22m`;
            const bc = (s: string) => `\x1b[38;2;196;167;224m${s}\x1b[39m`;

            // ── Box dimensions ──────────────────────────────────────────────
            // INNER = content width between the "│ " and " │" borders.
            // Capped at min(termCols − 4, 120) to prevent unbounded growth on
            // long titles or wide terminals.
            const INNER = computeBoxWidth(title.length);
            const HBAR = "─".repeat(INNER + 2); // fills between corner chars

            const topBar = bc("╭" + HBAR + "╮");
            const midBar = bc("├" + HBAR + "┤");
            const botBar = bc("╰" + HBAR + "╯");

            /** Wrap content in border chars, padded to INNER visible chars. */
            const row = (content: string): string => {
                const pad = " ".repeat(Math.max(0, INNER - vlen(content)));
                return bc("│") + " " + content + pad + " " + bc("│");
            };
            const blankRow = () => row("");

            // ── Build display lines ─────────────────────────────────────────
            const displayLines: string[] = [];

            displayLines.push(topBar);
            displayLines.push(row("📋  " + accent(bold(title))));

            if (description) {
                displayLines.push(blankRow());
                for (const dl of wrap(description, INNER - 4)) {
                    displayLines.push(row("  " + dimText(dl)));
                }
            }

            if (steps.length > 0) {
                displayLines.push(blankRow());
                steps.forEach((s, i) => {
                    displayLines.push(row("  " + accent(bold(`${i + 1}.`)) + " " + bold(s.title)));
                    if (s.description) {
                        for (const dl of wrap(s.description, INNER - 8)) {
                            displayLines.push(row("     " + dimText(dl)));
                        }
                    }
                });
            }

            displayLines.push(blankRow());
            displayLines.push(midBar);

            // Options in two-column layout (COL1 = 30 default matches makeOptRow default)
            displayLines.push(row(makeOptRow(
                accent("(1)") + " Clear Context & Begin",
                accent("(2)") + " Begin",
            )));
            displayLines.push(row(makeOptRow(
                accent("(3)") + " Suggest Edit",
                accent("(4)") + " Cancel",
            )));
            displayLines.push(botBar);

            void ctx.ui
                .input(displayLines.join("\n"), "Enter choice (1-4) or edit suggestion…", { signal: localAbort.signal })
                .then((value) => {
                    const answer = value?.trim();
                    if (!answer) {
                        localDone = true;
                        maybeFinishCancelled();
                        return;
                    }

                    if (answer === "1") {
                        localDone = true;
                        finish({ action: "execute" });
                    } else if (answer === "2") {
                        localDone = true;
                        finish({ action: "execute_keep_context" });
                    } else if (answer === "4") {
                        localDone = true;
                        finish({ action: "cancel" });
                    } else if (answer === "3") {
                        void ctx.ui
                            .input("Describe your suggested changes:", undefined, { signal: localAbort.signal })
                            .then((editValue) => {
                                localDone = true;
                                const suggestion = editValue?.trim();
                                if (suggestion) {
                                    finish({ action: "edit", editSuggestion: suggestion });
                                } else {
                                    finish({ action: "edit", editSuggestion: "No details provided." });
                                }
                            })
                            .catch(() => {
                                localDone = true;
                                finish({ action: "edit", editSuggestion: "No details provided." });
                            });
                    } else {
                        localDone = true;
                        finish({ action: "edit", editSuggestion: answer });
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

export function registerPlanModeTool(rctx: RelayContext) {
    rctx.pi.registerTool({
        name: PLAN_MODE_TOOL_NAME,
        label: "Plan Mode",
        description:
            "Submit a plan for user review before execution. The user can approve, edit, or cancel the plan. " +
            "Use this when you want to outline a multi-step approach and get user confirmation before proceeding. " +
            "The tool blocks until the user responds with one of: " +
            "'Clear Context & Begin' (user wants a fresh start — proceed with the plan), " +
            "'Begin' (proceed with current context), " +
            "'Suggest Edit' (user provides feedback to revise the plan — resubmit an updated plan), " +
            "or 'Cancel' (do not proceed).",
        parameters: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description: "Short title summarizing the plan.",
                },
                description: {
                    type: "string",
                    description: "Optional detailed description of the plan in markdown format.",
                },
                steps: {
                    type: "array",
                    description: "Ordered list of steps in the plan.",
                    items: {
                        type: "object",
                        properties: {
                            title: {
                                type: "string",
                                description: "Short title for this step.",
                            },
                            description: {
                                type: "string",
                                description: "Optional longer description of what this step entails.",
                            },
                        },
                        required: ["title"],
                    },
                },
            },
            required: ["title"],
            additionalProperties: false,
        } as any,
        async execute(toolCallId: string, rawParams: any, signal: any, onUpdate: any, ctx: any) {
            if (rctx.pendingPlanMode && rctx.pendingPlanMode.toolCallId !== toolCallId) {
                return {
                    content: [{ type: "text", text: "A different plan_mode prompt is already pending." }],
                    details: {
                        title: "",
                        description: null,
                        steps: [],
                        action: null,
                        editSuggestion: null,
                    } satisfies PlanModeDetails,
                };
            }

            const params = (rawParams ?? {}) as PlanModeParams;
            const title = typeof params.title === "string" ? params.title.trim() : "";
            const description = typeof params.description === "string" ? params.description.trim() || null : null;
            const steps: PlanModeStep[] = Array.isArray(params.steps)
                ? (params.steps as unknown[])
                    .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
                    .map((s) => ({
                        title: typeof s.title === "string" ? (s.title as string).trim() : "",
                        description: typeof s.description === "string" && (s.description as string).trim()
                            ? (s.description as string).trim()
                            : undefined,
                    }))
                    .filter((s) => s.title.length > 0)
                : [];

            if (!title) {
                return {
                    content: [{ type: "text", text: "plan_mode requires a non-empty title." }],
                    details: {
                        title: "",
                        description: null,
                        steps: [],
                        action: null,
                        editSuggestion: null,
                    } satisfies PlanModeDetails,
                };
            }

            onUpdate?.({
                content: [{ type: "text", text: `Waiting for plan review: ${title}` }],
                details: {
                    title,
                    description,
                    steps,
                    action: null,
                    editSuggestion: null,
                    status: "waiting",
                } satisfies PlanModeDetails,
            });

            // ── Child session: fire trigger to parent ──
            if (rctx.isChildSession && rctx.parentSessionId && rctx.isConnected()) {
                const triggerId = randomUUID();
                const trigger = {
                    type: "plan_review" as const,
                    sourceSessionId: rctx.relaySessionId,
                    sourceSessionName: rctx.getCurrentSessionName() ?? rctx.relaySessionId.slice(0, 8),
                    targetSessionId: rctx.parentSessionId,
                    payload: {
                        title,
                        steps,
                        description: description ?? undefined,
                    },
                    deliverAs: "followUp" as const,
                    expectsResponse: true,
                    triggerId,
                    timeoutMs: 300_000,
                    ts: new Date().toISOString(),
                };

                rctx.emitTrigger(trigger as any);

                const triggerResult = await rctx.waitForTriggerResponse(triggerId, trigger.timeoutMs, signal);

                // Treat timeout / delivery-failure as cancellation
                if (triggerResult.cancelled) {
                    return {
                        content: [{ type: "text", text: `Plan cancelled: ${triggerResult.response}` }],
                        details: {
                            title,
                            description,
                            steps,
                            action: "cancel" as PlanModeAction,
                            editSuggestion: null,
                        } satisfies PlanModeDetails,
                    };
                }

                const response = triggerResult.response;

                let isApproval: boolean;
                let isCancel: boolean;
                if (triggerResult.action) {
                    isApproval = triggerResult.action === "approve";
                    isCancel = triggerResult.action === "cancel";
                } else {
                    const lower = response.toLowerCase().trim();
                    isApproval = ["begin", "approve", "approved", "lgtm", "looks good", "proceed"].some(p => lower === p || lower.startsWith(p + " "));
                    isCancel = ["cancel", "stop", "no", "reject"].some(p => lower === p || lower.startsWith(p + " "));
                }

                let responseText: string;
                let action: PlanModeAction;
                if (isApproval) {
                    responseText = "Plan approved by parent. Proceeding.";
                    action = "execute_keep_context";
                    setPlanModeFromRemote(false);
                } else if (isCancel) {
                    responseText = "Plan cancelled by parent.";
                    action = "cancel";
                } else {
                    responseText = `Parent suggests edit: ${response}`;
                    action = "edit";
                }

                return {
                    content: [{ type: "text", text: responseText }],
                    details: {
                        title,
                        description,
                        steps,
                        action,
                        editSuggestion: action === "edit" ? response : null,
                    } satisfies PlanModeDetails,
                };
            }

            const result = await askPlanMode(rctx, toolCallId, title, description, steps, signal, ctx);

            if (!result) {
                return {
                    content: [{ type: "text", text: "Plan review was cancelled or no response received." }],
                    details: {
                        title,
                        description,
                        steps,
                        action: "cancel",
                        editSuggestion: null,
                    } satisfies PlanModeDetails,
                };
            }

            const actionLabel = {
                execute: "Clear Context & Begin",
                execute_keep_context: "Begin",
                edit: "Suggest Edit",
                cancel: "Cancel",
            }[result.action];

            if (result.action === "execute" || result.action === "execute_keep_context") {
                setPlanModeFromRemote(false);
            }

            if (result.action === "execute") {
                requestContextClear();
            }

            let responseText: string;
            if (result.action === "execute") {
                responseText = `User chose: ${actionLabel}. The user wants to clear the conversation context and start fresh to execute this plan. Proceed by executing the plan steps.`;
            } else if (result.action === "execute_keep_context") {
                responseText = `User chose: ${actionLabel}. The user approved the plan. Proceed by executing the plan steps with the current context.`;
            } else if (result.action === "edit" && result.editSuggestion) {
                responseText = `User chose: ${actionLabel}. Suggestion: ${result.editSuggestion}`;
            } else if (result.action === "cancel") {
                responseText = `User chose: ${actionLabel}. The user rejected the plan. Do not proceed with execution.`;
            } else {
                responseText = `User chose: ${actionLabel}`;
            }

            onUpdate?.({
                content: [{ type: "text", text: responseText }],
                details: {
                    title,
                    description,
                    steps,
                    action: result.action,
                    editSuggestion: result.editSuggestion ?? null,
                    status: "responded",
                } satisfies PlanModeDetails,
            });

            return {
                content: [{ type: "text", text: responseText }],
                details: {
                    title,
                    description,
                    steps,
                    action: result.action,
                    editSuggestion: result.editSuggestion ?? null,
                } satisfies PlanModeDetails,
            };
        },
    });
}
