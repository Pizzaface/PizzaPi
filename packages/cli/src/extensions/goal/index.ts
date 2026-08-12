/**
 * `/goal` extension — registers the slash command and manages per-session
 * goal state, including the automatic evaluator check after each agent run.
 *
 * Wiring:
 * - `pi.registerCommand("goal", …)` handles the slash command.
 * - `session_start` restores any persisted goal from custom entries.
 * - `turn_end` records turn spend and, **on run-ending turns only**, checks
 *   budgets and runs the configured evaluator (keyword or LLM). A `not_met`
 *   verdict auto-continues the loop by steering a follow-up user message, so
 *   the agent keeps working toward the goal without the user prompting each
 *   time. When the goal is met or a budget is exhausted, the goal is
 *   deactivated and control returns to the user.
 * - `session_shutdown` clears the in-memory entry for the session.
 *
 * ⚠️ Run boundaries matter. pi fires `turn_end` after **every** LLM
 * round-trip, including `stopReason: "toolUse"` turns where the agent is
 * mid-run and about to call more tools on its own. Steering or evaluating on
 * those turns floods the agent with redundant "keep going" messages, judges
 * half-finished work, and burns `--max-turns` on tool calls rather than agent
 * responses. Only `stop`/`length` turns end a run; everything else just
 * accrues spend.
 */
import type { MetaGoalStatus } from "@pizzapi/protocol";
import type {
    AssistantMessage,
    ToolResultMessage,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ExtensionFactory,
    TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { createLogger } from "@pizzapi/tools";
import { loadConfig } from "../../config/io.js";
import type { PizzaPiConfig } from "../../config/types.js";
import { hasActiveSubagents } from "../subagent/background-state.js";
import {
    checkBudget,
    clearGoal,
    persist,
    clearPendingGuidance,
    formatGoalStatus,
    getGoal,
    getPendingGuidance,
    recordCompletedRun,
    recordEvaluation,
    recordTurnSpend,
    resetSession,
    restoreGoal,
    setGoal,
    setPendingGuidance,
    toMetaGoalStatus,
    formatCompactGoalStatus,
} from "./state.js";
import { parseGoalArgs } from "./parser.js";
import {
    createLlmGoalEvaluator,
    createSessionCacheEvaluator,
    DEFAULT_EVALUATE_EVERY_N_TURNS,
    keywordGoalEvaluator,
    resolveEvaluatorModel,
} from "./evaluator.js";
import {
    captureSessionContext,
    getCapturedSessionContext,
    isCacheReuseViable,
    recordCacheOutcome,
    resetSessionContext,
    snapshotActiveTools,
    toLlmMessages,
} from "./session-context.js";
import { buildTranscript, extractLatestTurnText } from "./transcript.js";
import type {
    GoalCommandResult,
    GoalEvaluationContext,
    GoalEvaluator,
    GoalState,
} from "./types.js";
import { DEFAULT_MIN_TURNS_BEFORE_EVALUATE } from "./types.js";

const log = createLogger("goal");

type GoalConfig = NonNullable<PizzaPiConfig["goal"]>;

function getSessionId(ctx: ExtensionContext): string {
    // Prefer the live session manager over environment variables to avoid
    // cross-session state pollution when multiple sessions run in the same
    // process (e.g. spawned sub-agents or resumed sessions).
    return ctx.sessionManager.getSessionId() ?? process.env.PIZZAPI_SESSION_ID ?? process.env.SESSION_ID ?? "unknown";
}

function emitGoalStatusChanged(
    pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">,
    payload: MetaGoalStatus | null,
): void {
    const events = (pi as any).events;
    if (events && typeof events.emit === "function") {
        events.emit("goal:state_changed", payload);
    }
}

function broadcastGoalStatus(
    sessionId: string,
    state: GoalState | undefined,
    ctx: ExtensionContext,
    pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">,
): void {
    if (state?.status === "active") {
        ctx.ui.setStatus("goal", formatCompactGoalStatus(state));
        emitGoalStatusChanged(pi, toMetaGoalStatus(state));
    } else {
        ctx.ui.setStatus("goal", undefined);
        emitGoalStatusChanged(pi, null);
    }
}

function handleGoalCommand(
    args: string,
    ctx: ExtensionCommandContext,
    pi: Pick<ExtensionAPI, "appendEntry">,
): GoalCommandResult {
    const sessionId = getSessionId(ctx);

    try {
        const parsed = parseGoalArgs(args);

        if (parsed.statusOnly) {
            const state = getGoal(sessionId);
            if (!state) {
                return { success: true, message: "No active goal. Use /goal \"<condition>\" to set one." };
            }
            return { success: true, message: formatGoalStatus(state), state };
        }

        if (parsed.clear) {
            return clearGoal(sessionId, pi);
        }

        const state = setGoal(sessionId, parsed.condition, parsed.budget, pi);
        return {
            success: true,
            message: `Goal set: ${state.condition.description}`,
            state,
            kickoff: true,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, message: `Invalid /goal command: ${msg}` };
    }
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
    return (
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "assistant"
    );
}

/**
 * Whether this `turn_end` ends the agent's run (control returns to the user)
 * rather than continuing into another tool-call turn.
 *
 * - `toolUse`: the agent is mid-run and will keep going by itself.
 * - `aborted` / `error`: not a completed turn at all (Esc, rate limits) —
 *   handled separately so the goal stays active for a user follow-up.
 * - `stop` / `length`: the run is over; this is where the goal loop belongs.
 */
function isRunEndingTurn(message: unknown): boolean {
    if (!isAssistantMessage(message)) return false;
    return message.stopReason === "stop" || message.stopReason === "length";
}

function getAssistantUsage(message: unknown): { tokens: number; cost: number } {
    if (!isAssistantMessage(message)) return { tokens: 0, cost: 0 };
    return {
        tokens: message.usage?.totalTokens ?? 0,
        cost: Math.max(0, message.usage?.cost?.total ?? 0),
    };
}

function buildEvaluationContext(
    state: GoalState,
    event: TurnEndEvent,
    ctx: ExtensionContext,
): GoalEvaluationContext {
    const latestTurnText = extractLatestTurnText({
        assistantContent: isAssistantMessage(event.message)
            ? event.message.content
            : undefined,
        toolResults: event.toolResults as ToolResultMessage[],
    });
    const transcript = buildTranscript(ctx.sessionManager.getEntries() as any[]);

    return {
        latestTurnText,
        transcript,
        history: state.evaluations,
        turnCount: state.turnCount,
        tokenSpend: state.tokenSpend,
    };
}

/**
 * Load the `goal` config block once per `turn_end`. Failures fall back to
 * built-in defaults rather than surfacing an error — evaluator-model
 * resolution is where config problems get reported.
 */
function loadGoalConfig(cwd: string): GoalConfig {
    try {
        return loadConfig(cwd).goal ?? {};
    } catch {
        return {};
    }
}

/**
 * How often (in completed agent runs) to invoke the LLM evaluator. The
 * keyword evaluator is free/local and always runs (rate 1). Resolution
 * order: per-goal `--every`, then `config.goal.evaluateEveryNTurns`, then
 * the built-in default.
 */
function resolveEvaluateRate(state: GoalState, config: GoalConfig): number {
    if (state.condition.evaluator === "keyword") return 1;
    if (state.condition.evaluateEveryNTurns !== undefined) {
        return Math.max(1, state.condition.evaluateEveryNTurns);
    }
    return config.evaluateEveryNTurns !== undefined
        ? Math.max(1, config.evaluateEveryNTurns)
        : DEFAULT_EVALUATE_EVERY_N_TURNS;
}

/**
 * Minimum completed agent runs before the evaluator may run. Keeps the goal
 * from judging success before the agent has had a chance to act. Resolution
 * order: per-goal `--min-turns`, then `config.goal.minTurnsBeforeEvaluate`,
 * then `DEFAULT_MIN_TURNS_BEFORE_EVALUATE`.
 */
function resolveMinTurnsBeforeEvaluate(state: GoalState, config: GoalConfig): number {
    if (state.condition.minTurnsBeforeEvaluate !== undefined) {
        return Math.max(0, state.condition.minTurnsBeforeEvaluate);
    }
    return config.minTurnsBeforeEvaluate !== undefined
        ? Math.max(0, config.minTurnsBeforeEvaluate)
        : DEFAULT_MIN_TURNS_BEFORE_EVALUATE;
}

function stopForBudget(
    sessionId: string,
    state: GoalState,
    budgetReason: NonNullable<ReturnType<typeof checkBudget>>,
    pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">,
): void {
    clearPendingGuidance(sessionId);
    persist(state, pi);
    pi.sendMessage({
        customType: "goal_status",
        content: `Goal budget reached: ${budgetReason}. The goal is now inactive; you may continue the session.`,
        display: true,
    });
}

/**
 * Enforce budget guardrails. Returns true when a budget was exhausted and
 * the goal has been deactivated — callers must stop.
 *
 * Budget exhaustion only deactivates the goal; it never shuts the session
 * down. The agent returns control to the user naturally.
 */
function enforceBudget(
    sessionId: string,
    state: GoalState,
    pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">,
): boolean {
    const budgetReason = checkBudget(state);
    if (!budgetReason) return false;
    stopForBudget(sessionId, state, budgetReason, pi);
    return true;
}

/**
 * Start another agent run toward the goal.
 *
 * Delivered as `steer` so the goal continuation is never stuck behind the
 * follow-up queue.
 */
function steerContinuation(
    sessionId: string,
    state: GoalState,
    pi: Pick<ExtensionAPI, "sendUserMessage">,
): void {
    const guidance = getPendingGuidance(sessionId);
    pi.sendUserMessage(
        guidance
            ? `[Goal not met] ${guidance}\nContinue working toward the goal: ${state.condition.description}`
            : `Work toward this goal until it is met: ${state.condition.description}`,
        { deliverAs: "steer" },
    );
}

/**
 * Resolve the evaluator implementation for this check. Model-resolution
 * failures degrade to an "uncertain" verdict (which never auto-continues)
 * rather than throwing out of the turn handler.
 *
 * Preference order for the LLM evaluator:
 *   1. Reuse the session's own context on the session's model, so the judge
 *      call reads the conversation from the provider's prompt cache.
 *   2. A standalone prompt on the cheapest authenticated model, used when
 *      there is no captured prefix, when a model is explicitly pinned, or
 *      once a cache miss has proved the prefix doesn't match.
 */
async function resolveEvaluator(
    sessionId: string,
    state: GoalState,
    config: GoalConfig,
    ctx: ExtensionContext,
): Promise<GoalEvaluator> {
    if (state.condition.evaluator === "keyword") return keywordGoalEvaluator;

    const uncertain = (reason: string): GoalEvaluator => ({
        evaluate: async () => ({
            turnIndex: state.turnCount,
            verdict: "uncertain" as const,
            reason,
            timestamp: Date.now(),
        }),
    });

    try {
        const captured = getCapturedSessionContext(sessionId);
        const canReuseSession =
            !config.evaluatorModel &&
            captured !== undefined &&
            captured.messages.length > 0 &&
            isCacheReuseViable(sessionId) &&
            ctx.model !== undefined &&
            ctx.modelRegistry.hasConfiguredAuth(ctx.model);

        if (canReuseSession && ctx.model) {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
            if (auth.ok) {
                return createSessionCacheEvaluator({
                    completeSimple,
                    model: ctx.model,
                    apiKey: auth.apiKey,
                    maxTokens: config.evaluatorMaxTokens,
                    signal: ctx.signal,
                    captured: captured!,
                });
            }
        }

        const resolved = await resolveEvaluatorModel(ctx.modelRegistry, config.evaluatorModel);
        if (!resolved) {
            const reason = "No configured evaluator model with auth is available; skipping LLM evaluation.";
            log.warn(reason);
            return uncertain(reason);
        }
        return createLlmGoalEvaluator({
            completeSimple,
            model: resolved.model,
            apiKey: resolved.apiKey,
            maxTokens: config.evaluatorMaxTokens,
            signal: ctx.signal,
        });
    } catch (err) {
        const reason = `Failed to resolve goal evaluator model: ${err instanceof Error ? err.message : String(err)}`;
        log.error(reason);
        return uncertain(reason);
    }
}

async function runGoalStopCheck(
    event: TurnEndEvent,
    ctx: ExtensionContext,
    pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage" | "sendUserMessage">,
): Promise<void> {
    const sessionId = getSessionId(ctx);
    let state = getGoal(sessionId);
    if (!state || state.status !== "active") return;

    // Aborts and provider errors (including rate limits) are not completed
    // turns. Do not spend on them, and do not enqueue a goal continuation —
    // the goal stays active and idle for a user follow-up.
    if (isAssistantMessage(event.message) && (event.message.stopReason === "aborted" || event.message.stopReason === "error")) return;

    const usage = getAssistantUsage(event.message);
    state = recordTurnSpend(sessionId, usage.tokens, usage.cost) ?? state;

    // Mid-run tool-call turn: the agent is still working under the prompt it
    // already has. Accrue spend and enforce budgets (so a runaway tool loop
    // can't blow past --max-tokens / --max-cost), but never steer or evaluate
    // here — that is what a run boundary is for.
    if (!isRunEndingTurn(event.message)) {
        const budgetReason = checkBudget(state);
        if (budgetReason) stopForBudget(sessionId, state, budgetReason, pi);
        return;
    }

    // The run is over. Count it and persist the accrued spend.
    state = recordCompletedRun(sessionId) ?? state;
    persist(state, pi);

    // If background subagents or queued user/trigger messages are still
    // pending, don't start another goal iteration. The existing work will
    // produce more runs and the evaluator will check again when it's actually
    // idle. This prevents the goal loop from drowning out subagent results or
    // relay trigger responses.
    if (hasActiveSubagents() || (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages())) {
        return;
    }

    const config = loadGoalConfig(ctx.cwd);
    const minTurns = resolveMinTurnsBeforeEvaluate(state, config);
    const evaluateRate = resolveEvaluateRate(state, config);

    // Gate the evaluator on (a) enough completed runs to have produced real
    // work and (b) the configured cadence, measured as runs *since the last
    // evaluation* — not `turnCount % rate`, which spaces evaluations unevenly
    // once `minTurns` isn't a multiple of the rate. The first eligible run is
    // always evaluated so a goal satisfied right at the boundary resolves
    // immediately instead of waiting out the cadence.
    const eligible = state.turnCount >= Math.max(1, minTurns);
    const neverEvaluated = state.lastEvaluatedTurn === undefined;
    const runsSinceLastEval = state.turnCount - (state.lastEvaluatedTurn ?? 0);

    if (!eligible || (!neverEvaluated && runsSinceLastEval < evaluateRate)) {
        // Evaluator skipped this run, but the loop still runs and budgets
        // still bind.
        if (enforceBudget(sessionId, state, pi)) return;
        steerContinuation(sessionId, state, pi);
        return;
    }

    const evalContext = buildEvaluationContext(state, event, ctx);
    const evaluator = await resolveEvaluator(sessionId, state, config, ctx);

    try {
        const feedback = await evaluator.evaluate(state, evalContext);
        // Verify the shared-prefix assumption instead of trusting it. A miss
        // means we just paid full input price on the session model, so this
        // session stops reusing the session context from here on.
        if (feedback.cacheReadTokens !== undefined && recordCacheOutcome(sessionId, feedback.cacheReadTokens)) {
            log.warn(
                "Goal evaluator reused the session context but the provider reported no cache read; " +
                "falling back to a standalone evaluator call for the rest of this session.",
            );
        }
        state = recordEvaluation(sessionId, feedback, pi) ?? state;
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.error("Goal evaluation failed", err);
        state = recordEvaluation(sessionId, {
            turnIndex: state.turnCount,
            verdict: "uncertain",
            reason,
            timestamp: Date.now(),
        }, pi) ?? state;
    }

    if (state.status !== "active") {
        clearPendingGuidance(sessionId);
        if (state.stopReason === "goal_met") {
            pi.sendMessage({
                customType: "goal_status",
                content: `Goal met: ${state.condition.description}`,
                display: true,
            });
        } else {
            pi.sendMessage({
                customType: "goal_status",
                content: `Goal stopped: ${state.stopReason}.`,
                display: true,
            });
        }
        // Never shutdown when the goal is met. The agent finishes the current
        // run and returns control to the user.
        return;
    }

    // Budgets are checked AFTER evaluation so a goal met on the final
    // budgeted run reports "met" above instead of "budget reached".
    if (enforceBudget(sessionId, state, pi)) return;

    // Only a "not_met" verdict auto-continues. "uncertain" (evaluator failed,
    // no auth, unparseable reply) returns control to the user so a broken
    // evaluator can't spin the session forever.
    const lastEval = state.evaluations.at(-1);
    if (lastEval?.verdict === "not_met") {
        setPendingGuidance(sessionId, lastEval.reason);
        steerContinuation(sessionId, state, pi);
    } else {
        clearPendingGuidance(sessionId);
    }
}

export const goalExtension: ExtensionFactory = (pi) => {
    pi.registerCommand("goal", {
        description: "Set a success condition and optional budget for the session",
        getArgumentCompletions: (prefix: string) => {
            const options = [
                { value: "status", label: "status", description: "Show the active goal and budget" },
                { value: "clear", label: "clear", description: "Clear the active goal" },
            ];
            const p = prefix.trim().toLowerCase();
            const filtered = p ? options.filter((o) => o.value.startsWith(p)) : options;
            return filtered.length ? filtered : null;
        },
        handler: async (args, ctx) => {
            const result = handleGoalCommand(args, ctx, pi);
            pi.sendMessage({
                customType: "goal_status",
                content: result.message,
                display: true,
            });
            broadcastGoalStatus(getSessionId(ctx), getGoal(getSessionId(ctx)), ctx, pi);
            if (result.kickoff && result.state) {
                // Setting a goal starts a run immediately, with the condition
                // itself as the directive (parity with Claude Code /goal).
                pi.sendUserMessage(
                    `Work toward this goal until it is met: ${result.state.condition.description}`,
                    { deliverAs: "steer" },
                );
            }
        },
    });

    pi.on("session_start", (_event, ctx) => {
        const sessionId = getSessionId(ctx);
        const entries = ctx.sessionManager.getEntries();
        restoreGoal(sessionId, entries as any[]);
        broadcastGoalStatus(sessionId, getGoal(sessionId), ctx, pi);
    });

    // Snapshot the exact prefix pi sends to the provider so the evaluator can
    // re-send it and read from the prompt cache. Only captured while a goal is
    // active, and never modified — this handler always returns undefined.
    pi.on("context", (event, ctx) => {
        const sessionId = getSessionId(ctx);
        const state = getGoal(sessionId);
        if (!state || state.status !== "active" || state.condition.evaluator !== "llm") return undefined;
        if (!isCacheReuseViable(sessionId)) return undefined;

        captureSessionContext(sessionId, {
            systemPrompt: ctx.getSystemPrompt(),
            messages: toLlmMessages(event.messages),
            tools: snapshotActiveTools(pi),
            capturedAt: Date.now(),
        });
        return undefined;
    });

    pi.on("turn_end", async (event, ctx) => {
        await runGoalStopCheck(event, ctx, pi);
        broadcastGoalStatus(getSessionId(ctx), getGoal(getSessionId(ctx)), ctx, pi);
    });

    pi.on("session_shutdown", (_event, ctx) => {
        const sessionId = getSessionId(ctx);
        resetSession(sessionId);
        resetSessionContext(sessionId);
        emitGoalStatusChanged(pi, null);
    });
};
