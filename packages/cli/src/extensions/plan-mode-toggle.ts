import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { isSandboxActive, setReadOnlyOverlay } from "@pizzapi/tools";

// ── Safe-command detection ───────────────────────────────────────────────────

/**
 * DESTRUCTIVE_CMD_PATTERNS are checked against the first token (executable
 * name) of a command segment.  This avoids false positives when destructive
 * keywords appear as arguments, e.g. `grep "rm" src/`.
 */
const DESTRUCTIVE_CMD_PATTERNS = [
    /^\s*rm\b/i, /^\s*rmdir\b/i, /^\s*mv\b/i, /^\s*cp\b/i, /^\s*mkdir\b/i, /^\s*touch\b/i,
    /^\s*chmod\b/i, /^\s*chown\b/i, /^\s*chgrp\b/i, /^\s*ln\b/i, /^\s*tee\b/i,
    /^\s*truncate\b/i, /^\s*dd\b/i, /^\s*shred\b/i,
    /^\s*sudo\b/i, /^\s*su\b/i,
    /^\s*kill\b/i, /^\s*pkill\b/i, /^\s*killall\b/i,
    /^\s*reboot\b/i, /^\s*shutdown\b/i,
    /^\s*(vim?|nano|emacs|code|subl)\b/i,
    /^\s*npm\s+(install|uninstall|update|ci|link|publish)/i,
    /^\s*yarn\s+(add|remove|install|publish)/i,
    /^\s*pnpm\s+(add|remove|install|publish)/i,
    /^\s*bun\s+(add|remove|install|link|publish)/i,
    /^\s*pip\s+(install|uninstall)/i,
    /^\s*apt(-get)?\s+(install|remove|purge|update|upgrade)/i,
    /^\s*brew\s+(install|uninstall|upgrade)/i,
    /^\s*systemctl\s+(start|stop|restart|enable|disable)/i,
    /^\s*service\s+\S+\s+(start|stop|restart)/i,
];

/**
 * Read-only git subcommands allowed in plan mode.
 *
 * Uses an **allowlist** instead of a blocklist because enumerating all
 * destructive git subcommands is fragile — new git versions add more, and
 * commands like `git clean`, `git apply`, `git restore`, `git am`, etc. are
 * easy to miss. Any `git <subcommand>` not on this list is treated as
 * destructive when the OS sandbox is unavailable.
 */
const GIT_SAFE_SUBCOMMANDS = new Set([
    // Inspection / query
    "status", "log", "diff", "show", "blame", "grep", "shortlog",
    // Ref listing / lookup
    "branch", "tag", "remote", "stash",
    // Low-level read-only
    "ls-files", "ls-tree", "ls-remote", "cat-file", "rev-parse",
    "rev-list", "for-each-ref", "name-rev", "describe", "merge-base",
    "count-objects", "fsck", "verify-commit", "verify-tag", "verify-pack",
    // Diff plumbing (read-only)
    "diff-tree", "diff-files", "diff-index",
    // History / patch inspection (read-only, stdout-only)
    "archive", "cherry", "range-diff",
    // Misc read-only
    "help", "version", "config", "reflog", "worktree",
]);

/**
 * Git subcommand + argument combinations that are destructive even though
 * the subcommand itself is on the safe list (e.g. `git branch -D`, `git
 * remote add`, `git stash drop`, `git config --unset`, `git worktree add`).
 */
const GIT_SAFE_SUBCOMMAND_DESTRUCTIVE_OVERRIDES: RegExp[] = [
    // branch: -d/-D/-m/-M/-c/-C are mutating (must be a standalone short flag, not part of --merged etc.)
    /^\s*git\s+branch\s+.*\s-[dDmMcC]\b/i,
    /^\s*git\s+branch\s+-[dDmMcC]\b/i,
    // tag: -d (delete), -a/-s (create), or any arg that looks like a new tag name
    // We allow listing (no args, -l, --list, -n, --contains, --merged, etc.)
    /^\s*git\s+tag\s+.*-[dsafFu]/i,
    /^\s*git\s+tag\s+(?!-|$)\S/i, // `git tag v1.0` (creating a tag)
    // remote: add/remove/rm/rename/set-url/set-head/set-branches/prune/update
    /^\s*git\s+remote\s+(add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\b/i,
    // stash: push/save/drop/pop/apply/clear are mutating; only list/show are safe
    /^\s*git\s+stash\s+(push|save|drop|pop|apply|clear|create|store)\b/i,
    /^\s*git\s+stash\s*$/i, // bare `git stash` is `git stash push`
    // config: writing operations
    /^\s*git\s+config\s+.*--(unset|unset-all|remove-section|rename-section|replace-all|add)\b/i,
    /^\s*git\s+config\s+(?!.*--(get|get-all|get-regexp|list|show-origin|show-scope|type|default|includes))\S+\s+\S/i,
    // reflog: delete/expire are mutating; show is safe
    /^\s*git\s+reflog\s+(delete|expire)\b/i,
    // worktree: add/remove/move/repair are mutating; list is safe
    /^\s*git\s+worktree\s+(add|remove|move|repair|lock|unlock)\b/i,
    // archive: -o / --output writes to a file instead of stdout
    /^\s*git\s+archive\b.*\s(-o\s|-o\S|--output\b|--output=)/i,
];

/**
 * Patterns that are dangerous regardless of filesystem sandbox.
 * These cause non-filesystem side effects (process control, privilege
 * escalation, system management) that the OS sandbox does NOT prevent.
 *
 * When the sandbox IS active, only these patterns are checked — the sandbox's
 * read-only overlay handles filesystem write protection at the OS level.
 */
const SANDBOX_ONLY_CMD_PATTERNS = [
    // Process control & privilege escalation
    /^\s*sudo\b/i, /^\s*su\b/i,
    /^\s*kill\b/i, /^\s*pkill\b/i, /^\s*killall\b/i,
    /^\s*reboot\b/i, /^\s*shutdown\b/i,
    /^\s*systemctl\s+(start|stop|restart|enable|disable)/i,
    /^\s*service\s+\S+\s+(start|stop|restart)/i,
    // Remote / network side effects — sandbox only protects local filesystem
    /^\s*git\s+push\b/i,
    /^\s*git\s+remote\s+(add|remove|rename|set-url)\b/i,
    /^\s*npm\s+publish\b/i,
    /^\s*npx\b/i,
    /^\s*docker\s+push\b/i,
    /^\s*gh\s+(issue|pr|release)\s+(create|edit|close|merge|delete|comment)\b/i,
];

/**
 * DESTRUCTIVE_FLAG_PATTERNS are checked against the full command string.
 * These detect operators/flags that cause writes regardless of command name.
 */
const DESTRUCTIVE_FLAG_PATTERNS = [
    /(^|[^<])>(?!>)/, />>/,
    /\bcurl\b.*\s(-o\S|-o\s|--output\b|--output=|-O\b|--remote-name\b|--remote-name-all\b|-D\s|-D\S|--dump-header\b|--dump-header=|-c\s|-c\S|--cookie-jar\b|--cookie-jar=|--trace\b|--trace=|--trace-ascii\b|--trace-ascii=|--libcurl\b|--libcurl=|--stderr\b|--stderr=|--hsts\b|--hsts=|--alt-svc\b|--alt-svc=)/i,
    /\bwget\b.*\s(-O\b|--output-document\b|--output-document=)/i,
    /\bfind\b.*\s-exec(dir)?\b/i, /\bfind\b.*\s-ok(dir)?\b/i, /\bfind\b.*\s-delete\b/i, /\bfind\b.*\s-fprintf\b/i,
    /\bgit\b.*\s--output[= ]/i,
    /\bsort\b.*\s(-o\s|-o\S|--output\b|--output=)/i,
    // In-place editing via sed/perl -i
    /\bsed\b.*\s-i\b/i, /\bsed\b.*\s-i\S/i,
    /\bperl\b.*\s-i\b/i, /\bperl\b.*\s-i\S/i,
    // Interpreters executing scripts (not just --version/--help)
    /^\s*python[23]?\s+(?!--(version|help)\b)\S/i,
    /^\s*ruby\s+(?!--(version|help)\b)\S/i,
    /^\s*node\s+(?!--(version|help)\b)\S/i,
    // Build tools (not --dry-run / --just-print / -n)
    /^\s*make\b(?!.*(\s-n\b|\s--dry-run\b|\s--just-print\b))/i,
];

/**
 * Split a shell command on chaining operators (&&, ||, ;, |) and check that
 * every subcommand independently passes the safe-command check.  This prevents
 * bypass via e.g. `ls && make` or `git status; python script.py`.
 */
/**
 * Split a shell command string on unquoted chaining operators (&&, ||, ;, |, &).
 * Respects single and double quotes so that patterns like `rg "foo|bar"` are
 * not incorrectly split on the `|` inside the quotes.
 * @internal Exported for testing only.
 */
export function splitShellSegments(command: string): string[] {
    const segments: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];

        // Handle backslash escapes: a backslash before a quote (or any char)
        // means the next character is literal and should not toggle quote state.
        if (ch === "\\" && i + 1 < command.length) {
            current += ch + command[i + 1];
            i++; // skip the escaped character
            continue;
        }

        // Toggle quote state on unescaped quotes.
        if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }

        // Inside quotes — accumulate without checking for operators
        if (inSingle || inDouble) { current += ch; continue; }

        // Check for multi-char operators first: && and ||
        if (i + 1 < command.length) {
            const two = ch + command[i + 1];
            if (two === "&&" || two === "||") {
                segments.push(current);
                current = "";
                i++; // skip second char
                continue;
            }
        }

        // Single-char operators: ; | &
        if (ch === ";" || ch === "|" || ch === "&") {
            segments.push(current);
            current = "";
            continue;
        }

        current += ch;
    }
    segments.push(current);
    return segments;
}

/**
 * Check whether a single command segment is a destructive git invocation.
 *
 * Uses an **allowlist** of read-only git subcommands. Any git subcommand not
 * on the list is treated as destructive. For subcommands that are on the safe
 * list, a secondary override check catches argument combinations that are
 * still mutating (e.g. `git branch -D`, `git remote add`).
 */
function isDestructiveGitCommand(segment: string): boolean {
    const gitMatch = segment.match(/^\s*git\s+(\S+)/i);
    if (!gitMatch) return false; // not a git command

    const subcommand = gitMatch[1].toLowerCase();

    // Subcommand not on the safe list → destructive
    if (!GIT_SAFE_SUBCOMMANDS.has(subcommand)) return true;

    // Subcommand is safe in general, but check for destructive argument patterns
    return GIT_SAFE_SUBCOMMAND_DESTRUCTIVE_OVERRIDES.some((p) => p.test(segment));
}

/**
 * Check if a command looks destructive based on known patterns.
 *
 * For most commands this is a **blocklist** check — known destructive patterns
 * are flagged and everything else passes. For `git` specifically an
 * **allowlist** approach is used because the set of mutating git subcommands
 * is too large to enumerate reliably (git clean, git apply, git restore,
 * git am, git bisect, etc.).
 *
 * When `sandboxActive` is true, only non-filesystem side effects are checked
 * (process control, privilege escalation, system management, remote mutations).
 * The OS-level sandbox enforces filesystem write restrictions, so output
 * redirection, script interpreters, and `find -exec` are all safe.
 * Command substitution is still rejected to prevent smuggling blocked commands.
 *
 * When `sandboxActive` is false (default), the full regex battery is applied
 * as the only line of defense against destructive commands.
 *
 * @internal Exported for testing only.
 */
export function isDestructiveCommand(command: string, sandboxActive = false): boolean {
    // ── Sandbox-active path: lightweight check ───────────────────────────
    // The OS sandbox enforces a read-only filesystem overlay. We only need
    // to block non-filesystem side effects that the sandbox doesn't cover.
    if (sandboxActive) {
        // Multi-line payloads and command/backtick/process substitution are
        // still rejected — they can smuggle commands past the per-segment
        // check regardless of sandbox state.
        if (/\$\(|`|\n|<\(|>\(/.test(command)) return true;

        const parts = splitShellSegments(command);
        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;

            if (SANDBOX_ONLY_CMD_PATTERNS.some((p) => p.test(trimmed))) return true;
        }
        return false;
    }

    // ── No-sandbox path: full regex battery ──────────────────────────────
    // Reject command substitution, backtick expansion, process substitution,
    // and multi-line payloads that could smuggle destructive commands past
    // the per-segment check.
    if (/\$\(|`|\n|<\(|>\(/.test(command)) return true;

    // Split on shell chaining operators, respecting quotes
    const parts = splitShellSegments(command);

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue; // empty segment (e.g. trailing semicolon)

        // Git: allowlist-based check (stricter than the generic blocklist)
        if (/^\s*git\b/i.test(trimmed)) {
            if (isDestructiveGitCommand(trimmed)) return true;
            // Flag-level check still applies (e.g. git diff --output=...)
            if (DESTRUCTIVE_FLAG_PATTERNS.some((p) => p.test(trimmed))) return true;
            continue;
        }

        const isCmdDestructive = DESTRUCTIVE_CMD_PATTERNS.some((p) => p.test(trimmed));
        const isFlagDestructive = DESTRUCTIVE_FLAG_PATTERNS.some((p) => p.test(trimmed));
        if (isCmdDestructive || isFlagDestructive) return true;
    }

    return false;
}

/**
 * @deprecated Use `isDestructiveCommand` instead. Kept for backward compat during transition.
 * @internal Exported for testing only.
 */
export function isSafeCommand(command: string): boolean {
    return !isDestructiveCommand(command);
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
// Includes both core pi tools ("edit", "write") and PizzaPi custom tools ("write_file").
const BLOCKED_TOOLS = new Set(["edit", "write", "write_file"]);

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
    const TOGGLE_PLAN_MODE_TOOL = "toggle_plan_mode";

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

        // Always allow the agent to toggle plan mode off
        if (event.toolName === TOGGLE_PLAN_MODE_TOOL) return;

        // Block edit/write tools entirely
        if (BLOCKED_TOOLS.has(event.toolName)) {
            return {
                block: true,
                reason: `Plan mode: "${event.toolName}" is blocked in read-only mode. Use toggle_plan_mode to exit plan mode first.`,
            };
        }

        // Block destructive bash commands in plan mode.
        // When the OS sandbox is active, its read-only overlay enforces
        // filesystem write restrictions — so we only check for non-filesystem
        // side effects (kill, sudo, systemctl, remote mutations, etc.).
        // When the sandbox is NOT active, we apply the full regex battery
        // as the only line of defense.
        if (event.toolName === "bash") {
            const command = (event.input as any).command as string;
            if (isDestructiveCommand(command, isSandboxActive())) {
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
- You can use: read, bash (read-only commands only), grep, find, ls, and any MCP read tools
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to read-only commands (destructive commands are blocked)

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
            // On resume, the context message was already sent in the original session
            planModeContextSent = planModeEnabled;
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

        // Re-apply sandbox overlay to match restored plan mode state.
        // On resume with plan mode enabled, the overlay must be re-activated;
        // on resume with plan mode off, ensure it's cleared.
        if (isSandboxActive()) {
            setReadOnlyOverlay(planModeEnabled);
        }
        syncModuleState();
    });

    pi.on("session_switch", () => {
        const wasEnabled = planModeEnabled;
        planModeEnabled = false;
        executionMode = false;
        todoItems = [];
        planModeContextSent = false;
        _pendingContextClear = false;
        // Clear sandbox read-only overlay so the new session starts with full
        // write access. Without this, a previous session's plan mode leaks
        // read-only restrictions into the next session.
        if (wasEnabled && isSandboxActive()) {
            setReadOnlyOverlay(false);
        }
        syncModuleState();
        if (wasEnabled) {
            _onPlanModeChange?.(false);
        }
        persistState();
    });
};
