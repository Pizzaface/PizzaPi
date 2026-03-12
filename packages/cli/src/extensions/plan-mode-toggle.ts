import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

// ── Safe-command detection ───────────────────────────────────────────────────

const DESTRUCTIVE_PATTERNS = [
    /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
    /\bchmod\b/i, /\bchown\b/i, /\bchgrp\b/i, /\bln\b/i, /\btee\b/i,
    /\btruncate\b/i, /\bdd\b/i, /\bshred\b/i,
    /(^|[^<])>(?!>)/, />>/,
    /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
    /\byarn\s+(add|remove|install|publish)/i,
    /\bpnpm\s+(add|remove|install|publish)/i,
    /\bbun\s+(add|remove|install|link|publish)/i,
    /\bpip\s+(install|uninstall)/i,
    /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
    /\bbrew\s+(install|uninstall|upgrade)/i,
    /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
    /\bsudo\b/i, /\bsu\b/i,
    /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
    /\breboot\b/i, /\bshutdown\b/i,
    /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
    /\bservice\s+\S+\s+(start|stop|restart)/i,
    /\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
    /^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
    /^\s*grep\b/, /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/,
    /^\s*echo\b/, /^\s*printf\b/, /^\s*wc\b/, /^\s*sort\b/, /^\s*uniq\b/,
    /^\s*diff\b/, /^\s*file\b/, /^\s*stat\b/, /^\s*du\b/, /^\s*df\b/,
    /^\s*tree\b/, /^\s*which\b/, /^\s*whereis\b/, /^\s*type\b/,
    /^\s*env\b/, /^\s*printenv\b/, /^\s*uname\b/, /^\s*whoami\b/,
    /^\s*id\b/, /^\s*date\b/, /^\s*cal\b/, /^\s*uptime\b/,
    /^\s*ps\b/, /^\s*top\b/, /^\s*htop\b/, /^\s*free\b/,
    /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
    /^\s*git\s+ls-/i,
    /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
    /^\s*yarn\s+(list|info|why|audit)/i,
    /^\s*bun\s+(pm\s+ls|--version)/i,
    /^\s*node\s+--version/i, /^\s*python\s+--version/i,
    /^\s*curl\s/i, /^\s*wget\s+-O\s*-/i,
    /^\s*jq\b/, /^\s*sed\s+-n/i, /^\s*awk\b/,
    /^\s*rg\b/, /^\s*fd\b/, /^\s*bat\b/, /^\s*exa\b/,
];

function isSafeCommand(command: string): boolean {
    const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
    const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
    return !isDestructive && isSafe;
}

// ── Todo item types ──────────────────────────────────────────────────────────

export interface PlanTodoItem {
    step: number;
    text: string;
    completed: boolean;
}

function cleanStepText(text: string): string {
    let cleaned = text
        .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i, "")
        .replace(/\s+/g, " ")
        .trim();
    if (cleaned.length > 0) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    if (cleaned.length > 60) cleaned = `${cleaned.slice(0, 57)}...`;
    return cleaned;
}

function extractTodoItems(message: string): PlanTodoItem[] {
    const items: PlanTodoItem[] = [];
    const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
    if (!headerMatch) return items;

    const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
    const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

    for (const match of planSection.matchAll(numberedPattern)) {
        const text = match[2].trim().replace(/\*{1,2}$/, "").trim();
        if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
            const cleaned = cleanStepText(text);
            if (cleaned.length > 3) {
                items.push({ step: items.length + 1, text: cleaned, completed: false });
            }
        }
    }
    return items;
}

function extractDoneSteps(message: string): number[] {
    const steps: number[] = [];
    for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
        const step = Number(match[1]);
        if (Number.isFinite(step)) steps.push(step);
    }
    return steps;
}

function markCompletedSteps(text: string, items: PlanTodoItem[]): number {
    const doneSteps = extractDoneSteps(text);
    for (const step of doneSteps) {
        const item = items.find((t) => t.step === step);
        if (item) item.completed = true;
    }
    return doneSteps.length;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
    return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
    return message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

// ── Write-blocked tool names ─────────────────────────────────────────────────
// These tools are blocked when plan mode is active.
const BLOCKED_TOOLS = new Set(["edit", "write"]);

// ── Module-level state for remote extension to read ──────────────────────────

let _planModeEnabled = false;
let _executionMode = false;
let _todoItems: PlanTodoItem[] = [];

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

/** Callback for the remote extension to be notified when state changes. */
let _onPlanModeChange: ((enabled: boolean) => void) | null = null;

export function setPlanModeChangeCallback(cb: (enabled: boolean) => void): void {
    _onPlanModeChange = cb;
}

/** Toggle function exposed for the remote extension (/plan from web UI). */
let _toggleFn: (() => void) | null = null;

export function togglePlanModeFromRemote(): boolean {
    if (_toggleFn) {
        _toggleFn();
        return true;
    }
    return false;
}

// ── Extension ────────────────────────────────────────────────────────────────

export const planModeToggleExtension: ExtensionFactory = (pi) => {
    let todoItems: PlanTodoItem[] = [];
    let planModeEnabled = false;
    let executionMode = false;

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

    function togglePlanMode() {
        planModeEnabled = !planModeEnabled;
        executionMode = false;
        todoItems = [];
        syncModuleState();
        _onPlanModeChange?.(planModeEnabled);
        persistState();
    }

    // Expose toggle to the remote extension
    _toggleFn = togglePlanMode;

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

    // ── Block write tools in plan mode ───────────────────────────────────────
    pi.on("tool_call", async (event) => {
        if (!planModeEnabled) return;

        // Block edit/write tools entirely
        if (BLOCKED_TOOLS.has(event.toolName)) {
            return {
                block: true,
                reason: `Plan mode: "${event.toolName}" is blocked in read-only mode. Use /plan to exit plan mode first.`,
            };
        }

        // Block destructive bash commands
        if (event.toolName === "bash") {
            const command = (event.input as any).command as string;
            if (!isSafeCommand(command)) {
                return {
                    block: true,
                    reason: `Plan mode: command blocked (not in read-only allowlist). Use /plan to exit plan mode first.\nCommand: ${command}`,
                };
            }
        }
    });

    // ── Filter out stale plan mode context when not in plan mode ─────────────
    pi.on("context", async (event) => {
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
            return {
                message: {
                    customType: "plan-mode-context",
                    content: `[PLAN MODE ACTIVE]
You are in plan mode — a read-only exploration mode for safe code analysis.

Restrictions:
- You can use: read, bash (read-only commands only), grep, find, ls, and any MCP read tools
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to read-only commands (destructive commands are blocked)

Your task:
1. Explore the codebase using read-only tools
2. Ask clarifying questions if needed
3. Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes — just describe what you would do.`,
                    display: false,
                },
            };
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

    // ── Restore state on session start/resume ────────────────────────────────
    pi.on("session_start", async (_event, ctx) => {
        const entries = ctx.sessionManager.getEntries();

        // Restore persisted state
        const saved = entries
            .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode-toggle")
            .pop() as { data?: { enabled: boolean; todos?: PlanTodoItem[]; executing?: boolean } } | undefined;

        if (saved?.data) {
            planModeEnabled = saved.data.enabled ?? false;
            todoItems = saved.data.todos ?? [];
            executionMode = saved.data.executing ?? false;
        }

        // On resume: re-scan messages to rebuild completion state
        const isResume = saved !== undefined;
        if (isResume && executionMode && todoItems.length > 0) {
            let executeIndex = -1;
            for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i] as { type: string; customType?: string };
                if (entry.customType === "plan-mode-execute") {
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

        syncModuleState();
    });

    pi.on("session_switch", () => {
        planModeEnabled = false;
        executionMode = false;
        todoItems = [];
        syncModuleState();
    });
};
