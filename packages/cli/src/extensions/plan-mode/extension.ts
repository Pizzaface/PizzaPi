import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { isSandboxActive, setReadOnlyOverlay } from "@pizzapi/tools";
import { getPlanModeToolBlockReason, TOGGLE_PLAN_MODE_TOOL } from "./tool-policy.js";
import { isDestructiveCommand } from "./safe-command.js";
import { PlanTodoItem, extractTodoItems, markCompletedSteps, isAssistantMessage, getTextContent } from "./todo-items.js";

/**
 * Whether the live bash tool executes through the sandbox's wrapCommand (and
 * therefore honours the plan-mode read-only overlay). It currently does not:
 * background-bash.ts spawns the shell directly. Only flip this once the bash
 * path is wrapped; until then plan mode must not relax its filesystem checks.
 */
const BASH_PATH_IS_SANDBOX_WRAPPED = false;

// ── Module-level state for remote extension to read ──────────────────────────

let _planModeEnabled = false;
let _executionMode = false;
let _todoItems: PlanTodoItem[] = [];

/**
 * When the user picks "Clear Context & Begin" on a plan_mode prompt, the remote
 * extension calls `requestContextClear()` to set this flag.  The next `context`
 * event will strip all prior messages so the agent starts fresh, keeping only
 * the plan_mode tool-call/result exchange so the agent knows what to execute.
 */
let _pendingContextClear = false;

/** Returns true if plan mode (read-only exploration) is currently active. */
export function isPlanModeEnabled(): boolean {
    return _planModeEnabled;
}

/** Returns true if the agent is executing a previously-created plan. */
export function isExecutionMode(): boolean {
    return _executionMode;
}

/** Returns the current plan todo items (for heartbeats / web UI). */
export function getPlanTodoItems(): PlanTodoItem[] {
    return _todoItems;
}

/**
 * Signal that the next agent turn should start with a cleared context.
 * Called by the remote extension when the user picks "Clear Context & Begin".
 */
export function requestContextClear(): void {
    _pendingContextClear = true;
}

/** Callback for the remote extension to be notified when state changes. */
let _onPlanModeChange: ((enabled: boolean) => void) | null = null;

export function setPlanModeChangeCallback(cb: (enabled: boolean) => void): void {
    _onPlanModeChange = cb;
}

/** Meta event emitter for discrete plan_mode_toggled events. */
let _planModeMetaEmitter: ((enabled: boolean) => void) | null = null;
export function setPlanModeMetaEmitter(cb: (enabled: boolean) => void): void {
    _planModeMetaEmitter = cb;
}

/** Toggle function exposed for the remote extension (/plan from web UI). */
let _toggleFn: (() => void) | null = null;

/** Set-to-value function exposed for the remote extension and agent tool. */
let _setFn: ((enabled: boolean) => void) | null = null;

export function togglePlanModeFromRemote(): boolean {
    if (_toggleFn) {
        _toggleFn();
        return true;
    }
    return false;
}

/**
 * Set plan mode to a specific value (true = on, false = off).
 * Returns the new state, or null if the extension is not initialized.
 */
export function setPlanModeFromRemote(enabled: boolean): boolean | null {
    if (_setFn) {
        _setFn(enabled);
        return _planModeEnabled;
    }
    return null;
}

// ── Extension ────────────────────────────────────────────────────────────────

export const planModeToggleExtension: ExtensionFactory = (pi) => {
    let todoItems: PlanTodoItem[] = [];
    let planModeEnabled = false;
    let executionMode = false;
    /** True if the agent submitted a plan (via plan_mode tool) during the current plan mode session. */
    let planSubmittedDuringSession = false;
    /** True if a plan_mode tool was invoked during the current agent turn. Used to
     *  suppress the legacy agent_end plan menu when plan_mode already handled UX. */
    let planModeToolInvokedThisTurn = false;

    function syncModuleState() {
        _planModeEnabled = planModeEnabled;
        _executionMode = executionMode;
        _todoItems = todoItems;
    }

    function persistState() {
        pi.appendEntry("plan-mode-toggle", {
            enabled: planModeEnabled,
            todos: todoItems,
            executing: executionMode,
        });
    }

    /** True once the plan-mode context message has been injected for the current plan-mode session. */
    let planModeContextSent = false;

    function setPlanMode(enabled: boolean) {
        if (planModeEnabled === enabled) return;
        planModeEnabled = enabled;
        executionMode = false;
        todoItems = [];
        planModeToolInvokedThisTurn = false; // Always clear on state change
        if (enabled) {
            planSubmittedDuringSession = false;
            planModeContextSent = false; // Reset so the context message fires once on the next turn
        }
        // Toggle sandbox read-only overlay when sandbox is active.
        // This makes the OS enforce no-write for all bash commands in plan mode.
        if (isSandboxActive()) {
            setReadOnlyOverlay(enabled);
        }
        syncModuleState();
        _onPlanModeChange?.(planModeEnabled);
        if (_planModeMetaEmitter) _planModeMetaEmitter(planModeEnabled);
        persistState();
    }

    function togglePlanMode() {
        setPlanMode(!planModeEnabled);
    }

    // Expose toggle and set-to-value to the remote extension / agent tool
    _toggleFn = togglePlanMode;
    _setFn = setPlanMode;

    // ── /plan command ────────────────────────────────────────────────────────
    pi.registerCommand("plan", {
        description: "Toggle plan mode (read-only exploration — no edits until plan is approved)",
        handler: async (_args, ctx) => {
            togglePlanMode();
            if (planModeEnabled) {
                ctx.ui.notify("⏸ Plan mode ON — read-only exploration. Write/edit tools blocked.");
            } else {
                ctx.ui.notify("▶ Plan mode OFF — full tool access restored.");
            }
        },
    });

    // ── toggle_plan_mode tool — lets the agent enter/exit plan mode ─────────

    pi.registerTool({
        name: TOGGLE_PLAN_MODE_TOOL,
        label: "Toggle Plan Mode",
        description:
            "Enter or exit plan mode. In plan mode, you can only read files and run safe commands — " +
            "write/edit tools are blocked. Use this when you want to safely explore the codebase before making changes. " +
            "Call with enabled=true to enter plan mode, enabled=false to exit.",
        parameters: {
            type: "object",
            properties: {
                enabled: {
                    type: "boolean",
                    description: "true to enter plan mode (read-only), false to exit plan mode (full access).",
                },
            },
            required: ["enabled"],
            additionalProperties: false,
        } as any,
        async execute(_toolCallId, rawParams) {
            const params = (rawParams ?? {}) as { enabled?: boolean };
            const enabled = typeof params.enabled === "boolean" ? params.enabled : !planModeEnabled;

            const wasEnabled = planModeEnabled;
            const hadPlanSubmitted = planSubmittedDuringSession;
            setPlanMode(enabled);

            const stateLabel = planModeEnabled ? "ON (read-only)" : "OFF (full access)";
            const changed = wasEnabled !== planModeEnabled;

            // Soft-nudge: if exiting plan mode without having submitted a plan
            const exitedWithoutPlan = changed && wasEnabled && !enabled && !hadPlanSubmitted;
            const nudge = exitedWithoutPlan
                ? " Note: you exited plan mode without submitting a plan for user review. " +
                  "Next time, use the plan_mode tool to present your plan before exiting."
                : "";

            return {
                content: [{
                    type: "text" as const,
                    text: changed
                        ? `Plan mode is now ${stateLabel}.${nudge}`
                        : `Plan mode was already ${stateLabel}. No change.`,
                }],
                details: { enabled: planModeEnabled, changed },
            };
        },
    });

    // ── Block write tools in plan mode ───────────────────────────────────────
    pi.on("tool_call", async (event) => {
        // Track when the agent submits a plan during plan mode
        if (planModeEnabled && (event.toolName === "plan_mode" || event.toolName.endsWith(".plan_mode"))) {
            planSubmittedDuringSession = true;
            planModeToolInvokedThisTurn = true;
        }

        if (!planModeEnabled) return;

        // Default-deny: only tools known to be read-only may run (see
        // tool-policy.ts). This blocks write tools, session-spawning tools,
        // MCP tools not annotated `readOnlyHint: true`, and any unknown
        // extension/overlay tool; toggle_plan_mode is always allowed.
        //
        // spawn_session is blocked unconditionally — spawned child sessions are
        // independent processes with their own full write access and there is no
        // mechanism to inject plan-mode restrictions into them.
        //
        // subagent is also blocked for now because it similarly creates an isolated
        // context (separate agent process) that does not inherit plan-mode state.
        // TODO(plan-mode/subagent): Propagate plan-mode into subagent invocations
        // instead of blanket-blocking.  This would require the subagent tool to
        // accept and honor a read-only flag so that legitimate read-only delegation
        // (e.g. `subagent(agent: "researcher", task: "...")`) can continue to work
        // in plan mode.  The infrastructure change needed:
        //   1. Extend the subagent tool API with an `options.planMode: boolean` param.
        //   2. Have the subagent runner pass PIZZAPI_PLAN_MODE=1 (or equivalent) into
        //      the spawned agent environment.
        //   3. Load and enforce plan-mode restrictions inside the subagent session.
        const blockReason = getPlanModeToolBlockReason(event.toolName);
        if (blockReason) {
            return { block: true, reason: blockReason };
        }

        // Block destructive bash commands in plan mode.
        // Always apply the full (no-sandbox) battery: the live `bash` tool
        // (background-bash.ts) spawns commands directly and is NOT routed
        // through the sandbox's wrapCommand, so the read-only overlay toggled
        // by setReadOnlyOverlay() does not constrain it. Relaxing filesystem
        // checks because isSandboxActive() is true would let writes through.
        if (event.toolName === "bash") {
            const command = (event.input as { command?: unknown } | undefined)?.command;
            if (typeof command !== "string" || isDestructiveCommand(command, BASH_PATH_IS_SANDBOX_WRAPPED)) {
                return {
                    block: true,
                    reason: `Plan mode: command blocked (matches destructive pattern). Use toggle_plan_mode to exit plan mode first.\nCommand: ${command}`,
                };
            }
        }
    });

    // ── Filter out stale plan mode context when not in plan mode ─────────────
    pi.on("context", async (event) => {
        // "Clear Context & Begin" — strip all messages except the trailing
        // plan_mode tool-call/result pair so the agent starts fresh but still
        // knows which plan the user approved.
        if (_pendingContextClear) {
            _pendingContextClear = false;

            // Walk backwards and keep only the last assistant message that
            // contains a plan_mode tool call plus the following tool-result.
            const msgs = event.messages;
            let keepFrom = msgs.length;

            for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i] as any;
                // Look for the assistant message containing the plan_mode tool call
                if (m.role === "assistant" && Array.isArray(m.content)) {
                    const hasPlanTool = m.content.some(
                        (block: any) =>
                            (block.type === "toolCall" || block.type === "tool_use") &&
                            (block.name === "plan_mode" || block.name?.endsWith(".plan_mode")),
                    );
                    if (hasPlanTool) {
                        keepFrom = i;
                        break;
                    }
                }
            }

            return { messages: msgs.slice(keepFrom) };
        }

        if (planModeEnabled) return;

        return {
            messages: event.messages.filter((m) => {
                const msg = m as AgentMessage & { customType?: string };
                if (msg.customType === "plan-mode-context") return false;
                if (msg.role !== "user") return true;

                const content = msg.content;
                if (typeof content === "string") {
                    return !content.includes("[PLAN MODE ACTIVE]");
                }
                if (Array.isArray(content)) {
                    return !content.some(
                        (c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
                    );
                }
                return true;
            }),
        };
    });

    // ── Inject plan/execution context before each turn ───────────────────────
    pi.on("before_agent_start", async () => {
        if (planModeEnabled) {
            // Only inject the plan-mode context message once per plan-mode session,
            // not on every user message / agent turn.
            if (!planModeContextSent) {
                planModeContextSent = true;
                return {
                    message: {
                        customType: "plan-mode-context",
                        content: `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode for safe code analysis.

Restrictions:
- You can use: read, bash (read-only commands only), grep, find, ls, and MCP tools annotated read-only
- You CANNOT use: edit, write, subagent, spawn_session, or any tool not known to be read-only
- Bash is restricted to read-only commands (destructive, network-mutating, and script-interpreter commands are blocked)

Expected workflow:
1. Explore the codebase using read-only tools
2. Ask clarifying questions if needed
3. When ready, call the plan_mode tool to submit your plan for user review
4. If the user approves, plan mode exits automatically — just proceed with execution

Do NOT exit plan mode without submitting a plan first. Always present your plan for review via plan_mode.`,
                        display: false,
                    },
                };
            }
            return; // Already sent — no message needed
        }

        if (executionMode && todoItems.length > 0) {
            const remaining = todoItems.filter((t) => !t.completed);
            const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
            return {
                message: {
                    customType: "plan-execution-context",
                    content: `[EXECUTING PLAN — Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response (e.g. [DONE:1]).`,
                    display: false,
                },
            };
        }
    });

    // ── Track progress during execution ──────────────────────────────────────
    pi.on("turn_end", async (event) => {
        if (!executionMode || todoItems.length === 0) return;
        if (!isAssistantMessage(event.message)) return;

        const text = getTextContent(event.message);
        if (markCompletedSteps(text, todoItems) > 0) {
            syncModuleState();
        }
        persistState();
    });

    // ── Handle plan completion / post-plan menu ──────────────────────────────
    pi.on("agent_end", async (event, ctx) => {
        // Check if execution is complete
        if (executionMode && todoItems.length > 0) {
            if (todoItems.every((t) => t.completed)) {
                const completedList = todoItems.map((t) => `~~${t.text}~~`).join("\n");
                pi.sendMessage(
                    { customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
                    { triggerTurn: false },
                );
                executionMode = false;
                todoItems = [];
                syncModuleState();
                persistState();
            }
            return;
        }

        if (!planModeEnabled || !ctx.hasUI) return;

        // If the plan_mode tool was used this turn, it already handled user
        // interaction (approve/cancel/edit).  Skip the legacy agent_end menu
        // to avoid showing a second conflicting prompt.
        if (planModeToolInvokedThisTurn) {
            planModeToolInvokedThisTurn = false;
            return;
        }

        // Extract todos from last assistant message
        const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
        if (lastAssistant) {
            const extracted = extractTodoItems(getTextContent(lastAssistant));
            if (extracted.length > 0) {
                todoItems = extracted;
                syncModuleState();
            }
        }

        // Show plan steps
        if (todoItems.length > 0) {
            const todoListText = todoItems.map((t, i) => `${i + 1}. ☐ ${t.text}`).join("\n");
            pi.sendMessage(
                {
                    customType: "plan-todo-list",
                    content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
                    display: true,
                },
                { triggerTurn: false },
            );
        }

        const choice = await ctx.ui.select("Plan mode — what next?", [
            todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
            "Stay in plan mode",
            "Refine the plan",
        ]);

        if (choice?.startsWith("Execute")) {
            planModeEnabled = false;
            executionMode = todoItems.length > 0;
            // Lift sandbox read-only overlay so execution can write files
            if (isSandboxActive()) {
                setReadOnlyOverlay(false);
            }
            syncModuleState();
            _onPlanModeChange?.(false);

            const execMessage =
                todoItems.length > 0
                    ? `Execute the plan. Start with: ${todoItems[0].text}`
                    : "Execute the plan you just created.";
            pi.sendMessage(
                { customType: "plan-mode-execute", content: execMessage, display: true },
                { triggerTurn: true },
            );
        } else if (choice === "Refine the plan") {
            const refinement = await ctx.ui.editor("Refine the plan:", "");
            if (refinement?.trim()) {
                pi.sendUserMessage(refinement.trim());
            }
        }

        persistState();
    });

    // ── Restore state on session start / resume / switch / fork ──────────────
    //
    // The transcript is the source of truth for plan-mode state. Every session
    // transition (startup, --continue, /new, /resume, /fork, reload, and the
    // worker's in-place session_switch) re-derives state from the *target*
    // session's latest persisted "plan-mode-toggle" entry:
    //   - saved entry present → restore it (including the sandbox read-only
    //     overlay) BEFORE any tool call can run in that session;
    //   - no saved entry (genuinely new session) → reset to plan mode OFF so
    //     state from a previous session never leaks into a new one.
    // Restoring and resetting used to be two separate session_start handlers;
    // the unconditional reset ran second and silently disabled a resumed plan
    // mode (and its read-only overlay).
    function restoreStateFromSession(ctx: { sessionManager: { getEntries(): unknown[] } }, reason: string | undefined) {
        const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown; message?: unknown }>;
        const wasEnabled = planModeEnabled;

        const saved = entries
            .filter((e) => e.type === "custom" && e.customType === "plan-mode-toggle")
            .pop() as { data?: { enabled?: boolean; todos?: PlanTodoItem[]; executing?: boolean } } | undefined;

        if (saved?.data) {
            planModeEnabled = saved.data.enabled === true;
            todoItems = Array.isArray(saved.data.todos) ? saved.data.todos : [];
            executionMode = saved.data.executing === true;
            // On resume, the context message was already sent in the original session
            planModeContextSent = planModeEnabled;
        } else {
            planModeEnabled = false;
            todoItems = [];
            executionMode = false;
            planModeContextSent = false;
        }
        planSubmittedDuringSession = false;
        planModeToolInvokedThisTurn = false;
        // A pending "Clear Context & Begin" belongs to the session it was
        // requested in; only a same-session reload may keep it.
        if (reason !== "reload") _pendingContextClear = false;

        // On resume: re-scan messages to rebuild completion state
        if (saved?.data && executionMode && todoItems.length > 0) {
            let executeIndex = -1;
            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].customType === "plan-mode-execute") {
                    executeIndex = i;
                    break;
                }
            }

            const messages: AssistantMessage[] = [];
            for (let i = executeIndex + 1; i < entries.length; i++) {
                const entry = entries[i];
                if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
                    messages.push(entry.message as AssistantMessage);
                }
            }
            const allText = messages.map(getTextContent).join("\n");
            markCompletedSteps(allText, todoItems);
        }

        // Re-apply sandbox overlay to match the restored state: re-activate it
        // when resuming into plan mode, clear it otherwise.
        if (isSandboxActive()) {
            setReadOnlyOverlay(planModeEnabled);
        }
        syncModuleState();
        if (wasEnabled !== planModeEnabled) {
            _onPlanModeChange?.(planModeEnabled);
            _planModeMetaEmitter?.(planModeEnabled);
        }
    }

    pi.on("session_start", async (event, ctx) => {
        restoreStateFromSession(ctx, (event as { reason?: string } | undefined)?.reason);
    });

    // The runner worker performs /new, /resume and /fork in place and emits
    // "session_switch" (removed from upstream's type union, dispatched by
    // string key) instead of session_start. Restore from the target session
    // there too, otherwise the previous session's plan-mode state would apply.
    pi.on("session_switch" as any, async (event: { reason?: string } | undefined, ctx: { sessionManager: { getEntries(): unknown[] } }) => {
        restoreStateFromSession(ctx, event?.reason);
    });
};
