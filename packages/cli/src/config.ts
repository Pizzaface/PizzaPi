import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

/** Check if a value is a plain object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A single hook entry — a shell command to run at a lifecycle point. */
export interface HookEntry {
    /** Shell command to execute. Receives JSON on stdin. */
    command: string;
    /** Timeout in milliseconds. Default: 10000 (10s). */
    timeout?: number;
}

/** A matcher group — binds a tool name pattern to one or more hooks. */
export interface HookMatcher {
    /**
     * Tool name pattern to match. Supports `|` for alternation.
     * Examples: "Bash", "Edit|Write", "Read".
     * Use ".*" to match all tools.
     */
    matcher: string;
    /** Hooks to run when the matcher matches. */
    hooks: HookEntry[];
}

/** Hook configuration — shell scripts that run at agent lifecycle points. */
export interface HooksConfig {
    // -- Tool lifecycle hooks (use matchers to target specific tools) --

    /** Hooks that fire BEFORE a tool executes. Can block or inject context. */
    PreToolUse?: HookMatcher[];
    /** Hooks that fire AFTER a tool executes. Can inject context. */
    PostToolUse?: HookMatcher[];

    // -- Input hooks --

    /**
     * Fires when user input is received, before skill/template expansion.
     * Can transform text, block input, or mark it as handled.
     * Exit 0 + JSON `{ text: "..." }` → rewrite input.
     * Exit 0 + JSON `{ action: "handled" }` → consume without processing.
     * Exit 2 → block input (stderr shown as reason).
     */
    Input?: HookEntry[];

    /**
     * Fires after user prompt but before the agent loop starts.
     * Can inject context or tweak the system prompt for this turn.
     * Exit 0 + JSON `{ additionalContext: "...", systemPrompt: "..." }`.
     */
    BeforeAgentStart?: HookEntry[];

    /**
     * Fires when user executes a shell command via ! or !! prefix.
     * Important for safety parity with PreToolUse:Bash.
     * Exit 2 → block the command (stderr shown as reason).
     * Exit 0 → allow.
     */
    UserBash?: HookEntry[];

    // -- Session lifecycle hooks --

    /**
     * Fires before switching to another session. Can cancel.
     * Exit 2 → cancel the switch (stderr shown as reason).
     */
    SessionBeforeSwitch?: HookEntry[];

    /**
     * Fires before forking a session. Can cancel.
     * Exit 2 → cancel the fork (stderr shown as reason).
     */
    SessionBeforeFork?: HookEntry[];

    /**
     * Fires on process exit. Best-effort cleanup/checkpoint.
     * Exit code is ignored (the process is shutting down).
     */
    SessionShutdown?: HookEntry[];

    // -- Second wave hooks --

    /**
     * Fires before context compaction. Can cancel.
     * Exit 2 → cancel compaction (stderr shown as reason).
     */
    SessionBeforeCompact?: HookEntry[];

    /**
     * Fires before navigating in the session tree. Can cancel.
     * Exit 2 → cancel navigation (stderr shown as reason).
     */
    SessionBeforeTree?: HookEntry[];

    /**
     * Fires when a model is selected (observability).
     * Exit code is ignored.
     */
    ModelSelect?: HookEntry[];
}

/**
 * Built-in system prompt additions — always appended by the CLI.
 * User config `appendSystemPrompt` is concatenated after this.
 */
export const BUILTIN_SYSTEM_PROMPT = [
    "## Spawning Sessions & Linked Sessions\n",
    "Use the `spawn_session` tool to spawn long-running agent sessions (e.g., tasks that run in the background).",
    "**Spawned sessions are automatically linked to you as children.**",
    "Child session events (questions, plans, completion) are delivered as trigger messages in your conversation.",
    "No manual session ID plumbing needed — linking is automatic.",
    "Triggers arrive automatically as injected messages in your conversation — do NOT poll or wait for them.",
    "**Do NOT stall your conversation** with `sleep` loops or idle waits while a child is running.",
    "Simply stop responding — your session will automatically resume when the child's trigger arrives.\n",
    "**Opting out of auto-linking:** Pass `linked: false` to `spawn_session` when you plan to communicate",
    "with the child via `send_message`/`wait_for_message` instead of triggers. This prevents redundant",
    "`session_complete` triggers from arriving after you've already consumed the child's output via messages.\n",
    "**Handling child triggers:**\n",
    "- Trigger messages arrive with a `<!-- trigger:ID -->` metadata prefix in your conversation.",
    "- When a child calls `AskUserQuestion` or `plan_mode`, a trigger appears for you to respond to.",
    "- Use `respond_to_trigger(triggerId, response)` to answer a child's question or approve/reject a plan.",
    "  For `plan_review` triggers, also pass `action`: `\"approve\"` to accept, `\"cancel\"` to reject, or `\"edit\"` with feedback in `response`.",
    "  For `session_complete` triggers, use `action: \"ack\"` to acknowledge, or `action: \"followUp\"` with instructions in `response` to send the child more work.",
    "- Use `escalate_trigger(triggerId)` to pass a trigger to the human viewer if you can't handle it.",
    "- Use `tell_child(sessionId, message)` to proactively send a message or instruction to a child session.\n",

    "## Subagent Tool\n",
    "Use the `subagent` tool to delegate tasks to specialized agents with isolated context.",
    'A built-in `task` agent is always available for general-purpose work — use `subagent(agent: "task", task: "...")` to delegate any task without needing an agents folder.',
    "Additional agents are defined as markdown files in `~/.pizzapi/agents/` or `~/.claude/agents/` (user scope)",
    "and `.pizzapi/agents/` or `.claude/agents/` (project scope).",
    "Modes: single (`agent` + `task`), parallel (`tasks` array), chain (`chain` array with `{previous}` placeholder).",
    'Set `agentScope: "both"` to include project-local agents.\n',
    "**Prefer `subagent` over `spawn_session` for delegating work.**",
    "`subagent` is simpler, manages context isolation automatically, and returns results inline.",
    "Use `spawn_session` only when you need a long-running background session with independent lifecycle,",
    "or when you want to interact with the child session asynchronously via triggers.",
    "For most tasks — code changes, research, reviews, refactoring — `subagent` is the right choice.\n",
    "## Plan Mode\n",
    "Use the `plan_mode` tool when you want to outline a multi-step approach and get user confirmation before proceeding.",
    "Submit a structured plan with a title, optional description, and ordered steps.",
    "The tool blocks until the user responds with one of four actions:",
    "'Clear Context & Begin' (approve and start fresh), 'Begin' (approve and keep context),",
    "'Suggest Edit' (user provides feedback — revise and resubmit the plan), or 'Cancel' (do not proceed).",
    "When the user suggests an edit, incorporate their feedback into a revised plan and call `plan_mode` again.\n",
    "## Toggle Plan Mode\n",
    "Use the `toggle_plan_mode` tool to enter or exit read-only plan mode.",
    "Call with `enabled: true` to enter plan mode — write/edit tools and destructive bash commands are blocked,",
    "letting you safely explore the codebase. Call with `enabled: false` to exit and restore full tool access.",
    "Use this when you want to read and understand code before making changes.\n",
    "**Expected workflow:** enter plan mode → explore → call `plan_mode` to present your plan for user review →",
    "plan mode exits automatically when the user approves the plan ('Clear Context & Begin' or 'Begin'),",
    "so you do NOT need to call `toggle_plan_mode` after approval — just proceed with execution.",
    "Do not exit plan mode without first submitting a plan via `plan_mode` unless the task is trivial.\n",
    "## Asking Questions — AskUserQuestion\n",
    "Use `AskUserQuestion` when you need user input to proceed.",
    "It renders interactive UI elements (buttons, checkboxes, drag-to-rank) that are much easier to interact with than plain-text questions, especially on mobile.\n",
    "Each question has a `type` field:\n",
    "- `\"radio\"` (default) — Single-select. User picks exactly one option. Best for simple either/or decisions, choosing between approaches, or yes/no confirmations.\n",
    "- `\"checkbox\"` — Multi-select. User can pick zero or more options. Best for feature selection, choosing which items to include, or any \"select all that apply\" scenario.\n",
    "- `\"ranked\"` — Ranked-choice ordering. User drags options into priority order. Best for prioritization questions like \"which of these should we tackle first?\"\n",
    "Always provide pre-defined `options` for every question. The UI automatically adds a \"Write your own...\" free-form option, so you don't need to include one. Good options save the user time.\n",
    "Use the `questions` array to ask multiple questions at once — the UI renders them as a stepper (one at a time).",
    "Batch related questions together rather than making multiple separate tool calls.\n",
    "## Sandbox\n",
    "This session may run with OS-level sandbox restrictions that control which files you can read/write",
    "and which network domains are accessible. If a tool call is blocked by the sandbox,",
    "the error message will explain what was blocked and suggest updating the sandbox configuration.",
    "Do not attempt to circumvent sandbox restrictions — they are enforced at the OS level.\n",

    "## PizzaPi Configuration\n",
    "PizzaPi is built on top of pi but has its own configuration system. Understanding which file does what",
    "is critical — putting settings in the wrong file will silently have no effect.\n",
    "**`~/.pizzapi/config.json`** — PizzaPi's main configuration file. This is where you configure:\n",
    "- `hooks` — Shell-script hooks (PreToolUse, PostToolUse, Input, etc.) that run at agent lifecycle points.",
    "  Example: RTK token-optimization hooks go here under `hooks.PreToolUse`, NOT in settings.json.",
    "- `mcp` — MCP server definitions (stdio or streamable transports).",
    "- `sandbox` — Sandbox mode and filesystem/network overrides.",
    "- `skills` — Additional skill paths beyond the defaults.",
    "- `appendSystemPrompt` — Extra system prompt text appended after the built-in prompt.",
    "- `allowProjectHooks` — Trust gate for project-local hooks (must be set in global config).",
    "- `trustedPlugins` — Trusted Claude Code plugin directories.\n",
    "**`~/.pizzapi/settings.json`** — Pi TUI settings (model, provider, theme, terminal preferences).",
    "This file is managed by pi's settings UI. Do NOT put hooks, MCP servers, or other PizzaPi config here —",
    "PizzaPi does not read hooks from this file.\n",
    "**Project-local config:** `.pizzapi/config.json` in the project root can define project-specific hooks,",
    "MCP servers, and skills. Project hooks only run when `allowProjectHooks: true` is set in the GLOBAL",
    "`~/.pizzapi/config.json` (projects cannot self-authorize).\n",
    "**Key directories:**\n",
    "- `~/.pizzapi/hooks/` — Global hook scripts referenced by config.json",
    "- `~/.pizzapi/agents/` — Global agent definitions (markdown files)",
    "- `~/.pizzapi/skills/` — Global skill definitions",
    "- `.pizzapi/agents/` — Project-local agents",
    "- `.pizzapi/skills/` — Project-local skills\n",
    "**Claude Code compatibility:** PizzaPi also reads from `~/.claude/` paths (agents, skills) for",
    "backward compatibility, but PizzaPi-specific config (hooks, MCP, sandbox) must go in `~/.pizzapi/config.json`.",
].join(" ");

// ── Sandbox configuration ─────────────────────────────────────────────────────

/**
 * Sandbox preset modes.
 *
 * - `none`  — Sandbox disabled. All tool calls run directly on the host with no restrictions.
 * - `basic` — Filesystem-only protection. Sensitive dotfiles are blocked from reads/writes;
 *             writes are restricted to the project and /tmp. Network is unrestricted.
 * - `full`  — Full OS-level enforcement. Same filesystem rules as `basic`, plus network is
 *             deny-all by default (use `network.allowedDomains` overrides to permit domains).
 *
 * Default: `"basic"`.
 */
export type SandboxMode = "none" | "basic" | "full";

/**
 * Documented aliases for sandbox modes exposed via CLI `--sandbox` flag and
 * `PIZZAPI_SANDBOX` env var.  Maps user-facing names to internal `SandboxMode`.
 */
export const SANDBOX_MODE_ALIASES: Readonly<Record<string, SandboxMode>> = {
    enforce: "full",
    audit: "basic",
    off: "none",
    // Identity mappings so the canonical names also resolve
    full: "full",
    basic: "basic",
    none: "none",
};

/**
 * Resolve a raw sandbox override string (from CLI flag or env var) to a
 * validated `SandboxMode`.  Throws on unrecognised values so operators get
 * a clear error instead of a silent fallback to a weaker mode.
 *
 * Returns `undefined` when `raw` is `undefined`/empty (no override).
 */
export function validateSandboxOverride(raw: string | undefined): SandboxMode | undefined {
    if (raw === undefined || raw === "") return undefined;
    const resolved = SANDBOX_MODE_ALIASES[raw.toLowerCase()];
    if (resolved !== undefined) return resolved;
    const validValues = [...new Set([...Object.keys(SANDBOX_MODE_ALIASES)])].join(", ");
    throw new Error(
        `Invalid sandbox override "${raw}". ` +
        `Valid values: ${validValues}. Refusing to start with unknown mode.`,
    );
}

/**
 * User-facing sandbox config in `~/.pizzapi/config.json`.
 *
 * `mode` selects a preset. All other fields are srt-native overrides that are
 * deep-merged on top of the preset. They mirror the `~/.srt-settings.json`
 * format from `@anthropic-ai/sandbox-runtime` exactly.
 *
 * Overrides are ignored when `mode` is `"none"`.
 */
export interface SandboxConfig {
    /** Sandbox enforcement preset. Default: `"basic"`. */
    mode?: SandboxMode;
    /** Network access overrides (srt-native). Ignored in `none` mode. */
    network?: {
        /**
         * Domains the agent is allowed to reach (allow-only pattern).
         * Setting this switches network sandboxing on even in `basic` mode.
         * An empty array (`[]`) blocks all network access.
         */
        allowedDomains?: string[];
        /** Domains explicitly blocked (deny pattern). */
        deniedDomains?: string[];
        /** Allow the process to bind to local ports. Default: true. */
        allowLocalBinding?: boolean;
        /** Unix socket paths the process may access. */
        allowUnixSockets?: string[];
        /** Allow all Unix sockets (disables seccomp AF_UNIX blocking on Linux). */
        allowAllUnixSockets?: boolean;
        /** Override the HTTP proxy port. */
        httpProxyPort?: number;
        /** Override the SOCKS proxy port. */
        socksProxyPort?: number;
    };
    /** Filesystem access overrides (srt-native). Ignored in `none` mode. */
    filesystem?: {
        /** Additional paths the agent cannot read. Merged with preset denyRead. */
        denyRead?: string[];
        /**
         * Paths the agent may write to.
         * Replaces the preset allowWrite when specified.
         * Default preset value: `[".", "/tmp"]`.
         */
        allowWrite?: string[];
        /** Additional paths the agent must never write to. Merged with preset denyWrite. */
        denyWrite?: string[];
        /** Allow the process to write to .gitconfig. Default: false. */
        allowGitConfig?: boolean;
    };
    /** Pass-through srt options. Ignored in `none` mode. */
    ignoreViolations?: Record<string, string[]>;
    /** Disable network namespace removal on Linux (weaker isolation). */
    enableWeakerNetworkIsolation?: boolean;
    /** Allow nested sandbox-exec / bubblewrap with weaker profile. */
    enableWeakerNestedSandbox?: boolean;
    /** Depth limit for mandatory-deny path scanning on Linux. Default: 3. */
    mandatoryDenySearchDepth?: number;
    /** Allow pseudo-terminal allocation inside the sandbox. */
    allowPty?: boolean;
}

/**
 * Fully-resolved sandbox config passed to `@pizzapi/tools` `initSandbox()`.
 *
 * `mode` tells the tools layer whether to skip sandboxing entirely (`none`).
 * `srtConfig` is the srt `SandboxRuntimeConfig` to pass to `SandboxManager.initialize()`;
 * it is `null` when `mode` is `"none"`.
 */
export interface ResolvedSandboxConfig {
    mode: SandboxMode;
    /** Fully-resolved srt config, or null when sandbox is disabled. */
    srtConfig: SrtConfig | null;
}

/**
 * The subset of `SandboxRuntimeConfig` we populate.
 * Declared inline to avoid importing srt types into the CLI config module.
 */
export interface SrtConfig {
    network?: {
        allowedDomains: string[];
        deniedDomains: string[];
        allowLocalBinding?: boolean;
        allowUnixSockets?: string[];
        allowAllUnixSockets?: boolean;
        httpProxyPort?: number;
        socksProxyPort?: number;
    };
    filesystem: {
        denyRead: string[];
        allowWrite: string[];
        denyWrite: string[];
        allowGitConfig?: boolean;
    };
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNetworkIsolation?: boolean;
    enableWeakerNestedSandbox?: boolean;
    mandatoryDenySearchDepth?: number;
    allowPty?: boolean;
}

// ── Sensitive paths blocked by all non-none presets ───────────────────────────

const SENSITIVE_DENY_READ: string[] = [
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    "~/.config/gcloud",
    "~/.docker/config.json",
    "~/Library/Application Support/Google/Chrome",
    "~/Library/Application Support/Firefox",
    "~/.mozilla/firefox",
    "~/.config/google-chrome",
    "~/.config/chromium",
];

const SENSITIVE_DENY_WRITE: string[] = [
    ".env",
    ".env.local",
    "~/.ssh",
];

// ── Preset base configs (before path resolution) ──────────────────────────────

/**
 * `basic` preset: filesystem protection, unrestricted network.
 * No `network` key → srt does not activate network sandboxing.
 */
const PRESET_BASIC: Omit<SrtConfig, "network"> = {
    filesystem: {
        denyRead: SENSITIVE_DENY_READ,
        allowWrite: [".", "/tmp"],
        denyWrite: SENSITIVE_DENY_WRITE,
    },
};

/**
 * `full` preset: filesystem protection + network deny-all by default.
 * `network.allowedDomains: []` tells srt to block all outbound network.
 * Users add domain overrides to open specific holes.
 */
const PRESET_FULL: SrtConfig = {
    network: {
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
    },
    filesystem: {
        denyRead: SENSITIVE_DENY_READ,
        allowWrite: [".", "/tmp"],
        denyWrite: SENSITIVE_DENY_WRITE,
    },
};

/**
 * Coerce a raw JSON value into a `string[]` suitable for sandbox path/domain lists.
 *
 * Handles common user mistakes in config.json:
 *   - `"."` (bare string instead of array) → `["."]`
 *   - `[42, ".", null]` (non-string items) → `["."]` (non-strings filtered out)
 *   - `true` / `{}` / other non-array, non-string → `undefined` (falls back to preset)
 *
 * Returns `undefined` when the input is `undefined`/`null` so callers can
 * distinguish "not specified" from "explicitly empty".
 */
function coerceStringArray(value: unknown): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    // Unrecognised type (number, boolean, object) — ignore and fall back to preset
    return undefined;
}

/**
 * Sanitize a raw `SandboxConfig` from JSON, coercing array fields so that
 * downstream code can safely spread / `.map()` without `TypeError`.
 */
function sanitizeSandboxConfig(raw: SandboxConfig): SandboxConfig {
    return {
        ...raw,
        filesystem: raw.filesystem
            ? {
                  ...raw.filesystem,
                  denyRead: coerceStringArray(raw.filesystem.denyRead),
                  allowWrite: coerceStringArray(raw.filesystem.allowWrite),
                  denyWrite: coerceStringArray(raw.filesystem.denyWrite),
              }
            : undefined,
        network: raw.network
            ? {
                  ...raw.network,
                  allowedDomains: coerceStringArray(raw.network.allowedDomains),
                  deniedDomains: coerceStringArray(raw.network.deniedDomains),
                  allowUnixSockets: coerceStringArray(raw.network.allowUnixSockets),
              }
            : undefined,
    };
}

/**
 * Expand `~` to `os.homedir()` and resolve `.` to the given `cwd`.
 * Absolute paths are returned as-is (after ~ expansion).
 */
function resolveSandboxPath(p: string, cwd: string): string {
    const expanded = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
    if (expanded === ".") return resolve(cwd);
    // Relative paths (not starting with /) are resolved against cwd
    if (!expanded.startsWith("/")) return resolve(cwd, expanded);
    return expanded;
}

/**
 * Resolve a partial SandboxConfig into a ResolvedSandboxConfig.
 *
 * 1. Pick the base SrtConfig from the preset (`basic` or `full`).
 * 2. Deep-merge user overrides on top (deny lists union, allow lists replace).
 * 3. Expand all paths (`~` → homedir, `.` → cwd).
 * 4. Return `{ mode: "none", srtConfig: null }` when mode is `"none"`.
 */
export function resolveSandboxConfig(cwd: string, config: PizzaPiConfig): ResolvedSandboxConfig {
    const s = sanitizeSandboxConfig(config.sandbox ?? {});
    const rawMode = s.mode ?? "basic";

    // Validate mode — fail closed on unknown values to prevent silent security downgrades
    const VALID_MODES: readonly SandboxMode[] = ["none", "basic", "full"] as const;
    if (!VALID_MODES.includes(rawMode as SandboxMode)) {
        throw new Error(
            `Invalid sandbox mode "${rawMode}" in config. ` +
            `Valid values: ${VALID_MODES.join(", ")}. Refusing to start with unknown mode.`,
        );
    }
    const mode: SandboxMode = rawMode as SandboxMode;

    if (mode === "none") {
        return { mode: "none", srtConfig: null };
    }

    const resolvePaths = (paths: string[]): string[] =>
        paths.map((p) => resolveSandboxPath(p, cwd));

    // Start from the preset
    const preset: SrtConfig = mode === "full"
        ? { ...PRESET_FULL, filesystem: { ...PRESET_FULL.filesystem }, network: { ...PRESET_FULL.network! } }
        : { ...PRESET_BASIC, filesystem: { ...PRESET_BASIC.filesystem } };

    // ── Filesystem overrides ──────────────────────────────────────────────────
    // denyRead/denyWrite: union (user can add more denied paths)
    const denyRead = [
        ...preset.filesystem.denyRead,
        ...(s.filesystem?.denyRead ?? []),
    ];
    const denyWrite = [
        ...preset.filesystem.denyWrite,
        ...(s.filesystem?.denyWrite ?? []),
    ];
    // allowWrite: user value replaces preset when specified (opt-in narrowing or widening)
    const allowWrite = s.filesystem?.allowWrite ?? preset.filesystem.allowWrite;

    const filesystem: SrtConfig["filesystem"] = {
        denyRead: resolvePaths([...new Set(denyRead)]),
        allowWrite: resolvePaths(allowWrite),
        denyWrite: resolvePaths([...new Set(denyWrite)]),
        ...(s.filesystem?.allowGitConfig !== undefined
            ? { allowGitConfig: s.filesystem.allowGitConfig }
            : {}),
    };

    // ── Network overrides ─────────────────────────────────────────────────────
    // Presence of network.allowedDomains in the override activates srt network
    // sandboxing even in `basic` mode (user opted in explicitly).
    let network: SrtConfig["network"];

    if (preset.network) {
        // `full` preset: start from preset, apply overrides
        network = {
            allowedDomains: s.network?.allowedDomains ?? preset.network.allowedDomains,
            deniedDomains: [
                ...preset.network.deniedDomains,
                ...(s.network?.deniedDomains ?? []),
            ],
            allowLocalBinding: s.network?.allowLocalBinding ?? preset.network.allowLocalBinding,
            ...(s.network?.allowUnixSockets !== undefined
                ? { allowUnixSockets: s.network.allowUnixSockets }
                : {}),
            ...(s.network?.allowAllUnixSockets !== undefined
                ? { allowAllUnixSockets: s.network.allowAllUnixSockets }
                : {}),
            ...(s.network?.httpProxyPort !== undefined
                ? { httpProxyPort: s.network.httpProxyPort }
                : {}),
            ...(s.network?.socksProxyPort !== undefined
                ? { socksProxyPort: s.network.socksProxyPort }
                : {}),
        };
    } else if (s.network?.allowedDomains !== undefined) {
        // `basic` preset but user explicitly set allowedDomains → opt-in network sandboxing
        network = {
            allowedDomains: s.network.allowedDomains,
            deniedDomains: s.network.deniedDomains ?? [],
            allowLocalBinding: s.network.allowLocalBinding ?? true,
            ...(s.network.allowUnixSockets !== undefined
                ? { allowUnixSockets: s.network.allowUnixSockets }
                : {}),
            ...(s.network.allowAllUnixSockets !== undefined
                ? { allowAllUnixSockets: s.network.allowAllUnixSockets }
                : {}),
            ...(s.network.httpProxyPort !== undefined
                ? { httpProxyPort: s.network.httpProxyPort }
                : {}),
            ...(s.network.socksProxyPort !== undefined
                ? { socksProxyPort: s.network.socksProxyPort }
                : {}),
        };
    }
    // else: basic mode with no allowedDomains override → no network key → no network sandboxing

    const srtConfig: SrtConfig = {
        filesystem,
        ...(network !== undefined ? { network } : {}),
        ...(s.ignoreViolations !== undefined ? { ignoreViolations: s.ignoreViolations } : {}),
        ...(s.enableWeakerNetworkIsolation !== undefined
            ? { enableWeakerNetworkIsolation: s.enableWeakerNetworkIsolation }
            : {}),
        ...(s.enableWeakerNestedSandbox !== undefined
            ? { enableWeakerNestedSandbox: s.enableWeakerNestedSandbox }
            : {}),
        ...(s.mandatoryDenySearchDepth !== undefined
            ? { mandatoryDenySearchDepth: s.mandatoryDenySearchDepth }
            : {}),
        ...(s.allowPty !== undefined ? { allowPty: s.allowPty } : {}),
    };

    return { mode, srtConfig };
}

/**
 * Merge a global SandboxConfig with a project-local SandboxConfig.
 *
 * Security invariant: the project config CANNOT weaken the global config.
 *   - `mode`: ordered `none < basic < full`; project can only move to a stricter mode, not weaker.
 *   - `filesystem.denyRead` / `denyWrite`: union (project can add more denials, not remove).
 *   - `filesystem.allowWrite`: intersection when both are specified (project can only narrow).
 *   - `network.allowedDomains`: intersection when both are specified (project can only narrow).
 *   - `network.deniedDomains`: union (project can add more denials, not remove).
 */
export function mergeSandboxConfig(rawGlobal: SandboxConfig, rawProject: SandboxConfig): SandboxConfig {
    const global = sanitizeSandboxConfig(rawGlobal);
    const project = sanitizeSandboxConfig(rawProject);

    const union = (a: string[] | undefined, b: string[] | undefined): string[] | undefined => {
        const combined = [...(a ?? []), ...(b ?? [])];
        return combined.length > 0 ? [...new Set(combined)] : undefined;
    };

    const intersect = (
        g: string[] | undefined,
        p: string[] | undefined,
    ): string[] | undefined => {
        // When global is undefined, return undefined so the preset default is
        // used.  Returning `p` here would let the project-local config introduce
        // arbitrary allowlist values and widen preset protections.
        if (g === undefined) return undefined;
        if (p === undefined) return g;
        const pSet = new Set(p);
        const result = g.filter((item) => pSet.has(item));
        return result.length > 0 ? result : [];
    };

    // Mode: project can only escalate (none → basic → full)
    const modeStrength: Record<SandboxMode, number> = { none: 0, basic: 1, full: 2 };
    const globalMode: SandboxMode = global.mode ?? "basic";
    const projectMode: SandboxMode = project.mode ?? globalMode;
    const effectiveMode: SandboxMode =
        modeStrength[projectMode] >= modeStrength[globalMode] ? projectMode : globalMode;

    // For scalar fields: global wins (security invariant — project cannot weaken).
    // Helper: pick global value if defined, else use project fallback.
    const globalWins = <T>(g: T | undefined, p: T | undefined): T | undefined =>
        g !== undefined ? g : p;
    
    // For security-sensitive boolean flags: project cannot enable weakening when global
    // config is absent. Keep strict defaults (false for "enable weaker" options) to
    // prevent project-local config from reducing isolation strength.
    const keepStrict = (g: boolean | undefined, p: boolean | undefined): boolean | undefined => {
        // If global is set, use it (project cannot override)
        if (g !== undefined) return g;
        // If global is not set, only use project value if it maintains strict settings (false)
        return p === false ? false : undefined;
    };

    return {
        mode: effectiveMode,
        network: {
            allowedDomains: intersect(global.network?.allowedDomains, project.network?.allowedDomains),
            deniedDomains: union(global.network?.deniedDomains, project.network?.deniedDomains),
            allowLocalBinding: keepStrict(global.network?.allowLocalBinding, project.network?.allowLocalBinding),
            // Unix socket allowances: project cannot weaken
            // allowUnixSockets is a string[] allowlist — intersect so project can only narrow
            allowUnixSockets: intersect(global.network?.allowUnixSockets, project.network?.allowUnixSockets),
            // allowAllUnixSockets is a boolean weakening flag — keep strict default
            allowAllUnixSockets: keepStrict(global.network?.allowAllUnixSockets, project.network?.allowAllUnixSockets),
            // Proxy ports: global wins
            httpProxyPort: globalWins(global.network?.httpProxyPort, project.network?.httpProxyPort),
            socksProxyPort: globalWins(global.network?.socksProxyPort, project.network?.socksProxyPort),
        },
        filesystem: {
            denyRead: union(global.filesystem?.denyRead, project.filesystem?.denyRead),
            denyWrite: union(global.filesystem?.denyWrite, project.filesystem?.denyWrite),
            allowWrite: intersect(global.filesystem?.allowWrite, project.filesystem?.allowWrite),
            // allowGitConfig: must keep strict (false) default when global not set
            allowGitConfig: keepStrict(global.filesystem?.allowGitConfig, project.filesystem?.allowGitConfig),
        },
        // Top-level scalar fields: different rules per field type
        // ignoreViolations: global-only — project cannot suppress srt violation enforcement
        ignoreViolations: global.ignoreViolations,
        // Weaker-isolation flags must keep strict (false) default when no global config exists
        enableWeakerNetworkIsolation: keepStrict(global.enableWeakerNetworkIsolation, project.enableWeakerNetworkIsolation),
        enableWeakerNestedSandbox: keepStrict(global.enableWeakerNestedSandbox, project.enableWeakerNestedSandbox),
        // mandatoryDenySearchDepth: global-only — project cannot control search depth
        mandatoryDenySearchDepth: global.mandatoryDenySearchDepth,
        allowPty: keepStrict(global.allowPty, project.allowPty),
    };
}

/**
 * Web search configuration for a provider that supports server-side web search
 * (e.g., Anthropic's web_search_20250305 tool).
 */
export interface WebSearchConfig {
    /** Enable web search. Default: false. */
    enabled?: boolean;
    /** Maximum number of searches per request. Default: 5. */
    maxUses?: number;
    /** Only include results from these domains. */
    allowedDomains?: string[];
    /** Never include results from these domains. */
    blockedDomains?: string[];
}

/**
 * Provider-specific settings. Keys are provider names (e.g., "anthropic").
 */
export interface ProviderSettings {
    [provider: string]: {
        /** Web search configuration (Anthropic only). */
        webSearch?: WebSearchConfig;
    };
}

export interface PizzaPiConfig {
    /** Override the default system prompt */
    systemPrompt?: string;
    /** Global agent config directory. Default: ~/.pizzapi */
    agentDir?: string;
    /** Prepend text to the system prompt without replacing it */
    appendSystemPrompt?: string;
    /** API key for authenticating with the PizzaPi relay server */
    apiKey?: string;
    /** WebSocket URL of the PizzaPi relay server. Default: ws://localhost:7492. Set to "off" to disable relay entirely. */
    relayUrl?: string;
    /**
     * Additional skill paths to load (files or directories).
     * Merged on top of the default ~/.pizzapi/skills/ and .pizzapi/skills/ locations.
     * Supports ~ expansion and absolute paths.
     */
    skills?: string[];
    /**
     * Shell-script hooks that fire at tool lifecycle points.
     * Inspired by Claude Code hooks: scripts receive JSON on stdin,
     * exit 0 to allow (with optional additionalContext), exit 2 to block.
     */
    hooks?: HooksConfig;
    /**
     * Trust gate: allow project-local hooks (.pizzapi/config.json) to run.
     * Must be set in the GLOBAL ~/.pizzapi/config.json (or via
     * PIZZAPI_ALLOW_PROJECT_HOOKS=1 env var). Project configs cannot
     * self-authorize.
     *
     * When false/unset, only hooks from ~/.pizzapi/config.json (global) run.
     */
    allowProjectHooks?: boolean;

    /**
     * Project-local Claude Code plugins that have been explicitly trusted.
     * Each entry is the absolute path to the plugin root directory.
     *
     * Must be set in the GLOBAL ~/.pizzapi/config.json — project configs
     * cannot self-authorize (same pattern as allowProjectHooks).
     *
     * Managed via `pizza plugins trust <path>` / `pizza plugins untrust <path>`.
     */
    trustedPlugins?: string[];

    /**
     * MCP server names to skip during initialization.
     * Servers listed here won't be started or have their tools registered.
     * Both global and project lists are merged (union).
     */
    disabledMcpServers?: string[];

    /**
     * Timeout (in milliseconds) for each MCP server's tools/list call during
     * startup. Servers that don't respond within this window are skipped with
     * an error. Default: 30000 (30 seconds).
     * Set to 0 to disable the timeout entirely.
     */
    mcpTimeout?: number;

    /**
     * Sandbox configuration — controls filesystem, network, and socket access
     * restrictions for agent tool execution.
     *
     * Global config sets the baseline; project-local config can only narrow
     * permissions (add to deny lists, remove from allow lists), never widen them.
     */
    sandbox?: SandboxConfig;

    /**
     * Show a warning notification when startup takes longer than expected
     * (e.g. slow MCP servers, relay connection issues).
     * Default: true. Set to false to suppress these warnings.
     */
    slowStartupWarning?: boolean;

    /** Subagent execution settings */
    subagent?: {
        /** Max number of parallel tasks in a single subagent call. Default: 8. */
        maxParallelTasks?: number;
        /** Max concurrent agent sessions running simultaneously. Default: 4. */
        maxConcurrency?: number;
    };

    /**
     * Provider-specific settings (web search, etc.).
     * Keys are provider names (e.g., "anthropic").
     *
     * Example:
     * ```json
     * {
     *   "providerSettings": {
     *     "anthropic": {
     *       "webSearch": {
     *         "enabled": true,
     *         "maxUses": 5,
     *         "allowedDomains": ["docs.python.org"],
     *         "blockedDomains": ["example.com"]
     *       }
     *     }
     *   }
     * }
     * ```
     */
    providerSettings?: ProviderSettings;
}

function readJsonSafe(path: string): Partial<PizzaPiConfig> {
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
        return {};
    }
}

/**
 * Returns the global PizzaPi config directory path.
 * Tests can override this via _setGlobalConfigDir() since Bun caches os.homedir().
 */
let _globalConfigDirOverride: string | null = null;
export function globalConfigDir(): string {
    return _globalConfigDirOverride ?? join(homedir(), ".pizzapi");
}

/** Test-only: override the global config directory (Bun caches os.homedir()). */
export function _setGlobalConfigDir(dir: string | null): void {
    _globalConfigDirOverride = dir;
}

/** Deep-merge hooks: concatenate arrays from both sources for every hook type. */
export function mergeHooks(a?: HooksConfig, b?: HooksConfig): HooksConfig | undefined {
    if (!a && !b) return undefined;
    const merged: HooksConfig = {};

    // Matcher-based hooks (PreToolUse / PostToolUse)
    const pre = [...(a?.PreToolUse ?? []), ...(b?.PreToolUse ?? [])];
    const post = [...(a?.PostToolUse ?? []), ...(b?.PostToolUse ?? [])];
    if (pre.length > 0) merged.PreToolUse = pre;
    if (post.length > 0) merged.PostToolUse = post;

    // Entry-based hooks — concatenate arrays from both sources
    const entryKeys: (keyof HooksConfig)[] = [
        "Input",
        "BeforeAgentStart",
        "UserBash",
        "SessionBeforeSwitch",
        "SessionBeforeFork",
        "SessionShutdown",
        "SessionBeforeCompact",
        "SessionBeforeTree",
        "ModelSelect",
    ];
    for (const key of entryKeys) {
        const combined = [
            ...((a?.[key] as HookEntry[] | undefined) ?? []),
            ...((b?.[key] as HookEntry[] | undefined) ?? []),
        ];
        if (combined.length > 0) {
            (merged as any)[key] = combined;
        }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Check whether project-local hooks are trusted.
 * Trust must come from the global config or the environment — never from
 * the project config itself (that would be a self-authorization bypass).
 */
export function isProjectHooksTrusted(globalConfig: Partial<PizzaPiConfig>): boolean {
    if (process.env.PIZZAPI_ALLOW_PROJECT_HOOKS === "1") return true;
    return globalConfig.allowProjectHooks === true;
}

/**
 * Load PizzaPi config from:
 *   1. ~/.pizzapi/config.json  (global)
 *   2. <cwd>/.pizzapi/config.json  (project-local, wins on conflict)
 *
 * Hooks: global hooks always run. Project hooks only run when explicitly
 * trusted via `allowProjectHooks: true` in the global config or the
 * PIZZAPI_ALLOW_PROJECT_HOOKS=1 env var.
 */
/**
 * Load only the global config from `~/.pizzapi/config.json` without merging
 * project-local overrides.  Useful when the caller needs the raw user-level
 * settings (e.g. for the sandbox settings editor).
 */
export function loadGlobalConfig(): Partial<PizzaPiConfig> {
    const globalPath = join(globalConfigDir(), "config.json");
    return readJsonSafe(globalPath);
}

export function loadConfig(cwd: string = process.cwd()): PizzaPiConfig {
    const globalPath = join(globalConfigDir(), "config.json");
    const projectPath = join(cwd, ".pizzapi", "config.json");
    const global = readJsonSafe(globalPath);
    const project = readJsonSafe(projectPath);

    // Trust gate: project hooks require explicit authorization from global config
    const projectHooksTrusted = isProjectHooksTrusted(global);
    const projectHooks = projectHooksTrusted ? project.hooks : undefined;
    if (project.hooks && !projectHooksTrusted) {
        console.warn(
            "[hooks] Project hooks found in .pizzapi/config.json but not trusted. " +
                'Set "allowProjectHooks": true in ~/.pizzapi/config.json or ' +
                "PIZZAPI_ALLOW_PROJECT_HOOKS=1 to enable.",
        );
    }

    const hooks = mergeHooks(global.hooks, projectHooks);
    const config = { ...global, ...project };
    if (hooks) config.hooks = hooks;
    else delete config.hooks;

    // Merge sandbox config securely — project cannot weaken global sandbox.
    // mergeSandboxConfig ensures: deny lists union, allow lists intersect,
    // mode/enabled cannot be relaxed by a project config.
    if (global.sandbox || project.sandbox) {
        config.sandbox = mergeSandboxConfig(
            global.sandbox ?? {},
            project.sandbox ?? {},
        );
    }

    // Deep-merge mcpServers (Claude Code compatibility format) from both scopes.
    // Project entries win on name conflicts, but global servers are preserved.
    // mcpServers is not in the PizzaPiConfig type — it flows through as untyped JSON.
    const globalMcpServers = isPlainObject((global as any).mcpServers) ? (global as any).mcpServers : undefined;
    const projectMcpServers = isPlainObject((project as any).mcpServers) ? (project as any).mcpServers : undefined;
    if (globalMcpServers || projectMcpServers) {
        (config as any).mcpServers = { ...globalMcpServers, ...projectMcpServers };
    }

    // Deep-merge mcp.servers (preferred array format) from both scopes.
    // Project entries win on name conflicts (matched by server name).
    const globalMcp = isPlainObject((global as any).mcp) ? (global as any).mcp : undefined;
    const projectMcp = isPlainObject((project as any).mcp) ? (project as any).mcp : undefined;
    if (globalMcp || projectMcp) {
        const globalServers: any[] = Array.isArray(globalMcp?.servers) ? globalMcp.servers : [];
        const projectServers: any[] = Array.isArray(projectMcp?.servers) ? projectMcp.servers : [];
        // Build a map keyed by server name — project entries overwrite global ones
        const serverMap = new Map<string, any>();
        for (const s of globalServers) {
            if (isPlainObject(s) && typeof s.name === "string") serverMap.set(s.name, s);
        }
        for (const s of projectServers) {
            if (isPlainObject(s) && typeof s.name === "string") serverMap.set(s.name, s);
        }
        (config as any).mcp = {
            ...globalMcp,
            ...projectMcp,
            servers: [...serverMap.values()],
        };
    }

    // Merge disabledMcpServers from both scopes (union).
    // Guard with Array.isArray — a malformed config value (e.g. a string or
    // object) would throw or spread into characters without this check.
    const globalDisabledRaw = Array.isArray(global.disabledMcpServers) ? global.disabledMcpServers : [];
    const projectDisabledRaw = Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers : [];
    const disabledMcpServers = [
        ...globalDisabledRaw,
        ...projectDisabledRaw,
    ].filter((s): s is string => typeof s === "string");
    if (disabledMcpServers.length > 0) {
        config.disabledMcpServers = [...new Set(disabledMcpServers)];
    } else {
        delete config.disabledMcpServers;
    }

    return config;
}

export function expandHome(path: string): string {
    return path.replace(/^~/, homedir());
}

export function defaultAgentDir(): string {
    return join(homedir(), ".pizzapi");
}

// ── Plugin trust helpers ──────────────────────────────────────────────────────

/**
 * Read the global trusted plugins list.
 * Returns the normalized list of absolute plugin root paths.
 */
export function getTrustedPlugins(): string[] {
    const globalPath = join(globalConfigDir(), "config.json");
    const global = readJsonSafe(globalPath);
    return Array.isArray(global.trustedPlugins) ? global.trustedPlugins.filter((p): p is string => typeof p === "string") : [];
}

/**
 * Check whether a plugin at the given root path is in the trust list.
 */
export function isPluginTrusted(pluginRootPath: string): boolean {
    const resolved = pluginRootPath.replace(/\/+$/, ""); // strip trailing slashes
    return getTrustedPlugins().some((p) => p.replace(/\/+$/, "") === resolved);
}

/**
 * Add a plugin root path to the global trust list.
 * Returns true if it was added (false if already present).
 */
export function trustPlugin(pluginRootPath: string): boolean {
    const resolved = pluginRootPath.replace(/\/+$/, "");
    const list = getTrustedPlugins();
    if (list.some((p) => p.replace(/\/+$/, "") === resolved)) return false;
    list.push(resolved);
    saveGlobalConfig({ trustedPlugins: list });
    return true;
}

/**
 * Remove a plugin root path from the global trust list.
 * Returns true if it was removed (false if not found).
 */
export function untrustPlugin(pluginRootPath: string): boolean {
    const resolved = pluginRootPath.replace(/\/+$/, "");
    const list = getTrustedPlugins();
    const filtered = list.filter((p) => p.replace(/\/+$/, "") !== resolved);
    if (filtered.length === list.length) return false;
    saveGlobalConfig({ trustedPlugins: filtered });
    return true;
}

/**
 * Merge fields into ~/.pizzapi/config.json (global config).
 */
/**
 * Bridge providerSettings from config.json to env vars consumed by the
 * pi-ai Anthropic patch. Env vars take precedence if already set.
 * Call this early in both CLI and worker entry points.
 */
export function applyProviderSettingsEnv(config: PizzaPiConfig): void {
    const ws = config.providerSettings?.anthropic?.webSearch;
    if (ws?.enabled && !process.env.PIZZAPI_WEB_SEARCH) {
        process.env.PIZZAPI_WEB_SEARCH = "1";
    }
    if (ws?.maxUses != null && !process.env.PIZZAPI_WEB_SEARCH_MAX_USES) {
        process.env.PIZZAPI_WEB_SEARCH_MAX_USES = String(ws.maxUses);
    }
    if (ws?.allowedDomains?.length && !process.env.PIZZAPI_WEB_SEARCH_ALLOWED_DOMAINS) {
        process.env.PIZZAPI_WEB_SEARCH_ALLOWED_DOMAINS = ws.allowedDomains.join(",");
    }
    if (ws?.blockedDomains?.length && !process.env.PIZZAPI_WEB_SEARCH_BLOCKED_DOMAINS) {
        process.env.PIZZAPI_WEB_SEARCH_BLOCKED_DOMAINS = ws.blockedDomains.join(",");
    }
}

export function saveGlobalConfig(fields: Partial<PizzaPiConfig>): void {
    const dir = globalConfigDir();
    const path = join(dir, "config.json");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existing = readJsonSafe(path);
    writeFileSync(path, JSON.stringify({ ...existing, ...fields }, null, 2), "utf-8");
}

/**
 * Merge fields into <cwd>/.pizzapi/config.json (project-local config).
 */
export function saveProjectConfig(fields: Partial<PizzaPiConfig>, cwd: string = process.cwd()): void {
    const dir = join(cwd, ".pizzapi");
    const path = join(dir, "config.json");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existing = readJsonSafe(path);
    writeFileSync(path, JSON.stringify({ ...existing, ...fields }, null, 2), "utf-8");
}

// ── MCP server disable/enable helpers ─────────────────────────────────────────

/**
 * Toggle an MCP server's disabled state in the project-local config.
 *
 * @param name - MCP server name to toggle
 * @param disable - true to disable, false to enable
 * @param cwd - project root directory
 * @returns Object describing the result:
 *   - `changed`: whether the config was actually modified
 *   - `globallyDisabled`: true if the server is disabled in the global config
 *     (project enable can't override)
 */
export function toggleMcpServer(
    name: string,
    disable: boolean,
    cwd: string = process.cwd(),
): { changed: boolean; globallyDisabled: boolean } {
    const globalPath = join(globalConfigDir(), "config.json");
    const globalConfig = readJsonSafe(globalPath);
    const globalDisabled = new Set(
        (Array.isArray(globalConfig.disabledMcpServers) ? globalConfig.disabledMcpServers : [])
            .filter((s): s is string => typeof s === "string"),
    );

    // If the server is already disabled globally, the project toggle is a no-op:
    //  - enable: project can't override a global disable
    //  - disable: already effective, writing a redundant local entry would
    //    create a sticky disable that survives removal of the global entry
    if (globalDisabled.has(name)) {
        return { changed: false, globallyDisabled: true };
    }

    const projectPath = join(cwd, ".pizzapi", "config.json");
    const projectConfig = readJsonSafe(projectPath);
    const current = new Set(
        (Array.isArray(projectConfig.disabledMcpServers) ? projectConfig.disabledMcpServers : [])
            .filter((s): s is string => typeof s === "string"),
    );

    const hadIt = current.has(name);
    if (disable) {
        current.add(name);
    } else {
        current.delete(name);
    }

    if (disable === hadIt) {
        return { changed: false, globallyDisabled: false };
    }

    const updated: Partial<PizzaPiConfig> = {};
    if (current.size > 0) {
        updated.disabledMcpServers = [...current];
    } else {
        // Remove the key entirely when empty
        const full = { ...projectConfig };
        delete full.disabledMcpServers;
        const dir = join(cwd, ".pizzapi");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "config.json"), JSON.stringify(full, null, 2), "utf-8");
        return { changed: true, globallyDisabled: false };
    }

    saveProjectConfig(updated, cwd);
    return { changed: true, globallyDisabled: false };
}
