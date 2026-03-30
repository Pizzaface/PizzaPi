/** Check if a value is a plain object (not null, not an array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
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

/**
 * Tool search configuration — enables dynamic tool discovery to reduce
 * context window bloat when many MCP tools are registered.
 *
 * When enabled, MCP tools that exceed the token threshold are deactivated
 * from the context window. A `search_tools` tool is registered that the
 * LLM can call to discover and load deferred tools on-demand.
 */
export interface ToolSearchConfig {
    /** Enable tool search. Default: false. */
    enabled?: boolean;
    /**
     * Character threshold for MCP tool descriptions. If the total character
     * count of all MCP tool definitions (name + description + schema) exceeds
     * this, tools are deferred. Default: 10000.
     *
     * Roughly 4 characters ≈ 1 token, so 10000 chars ≈ 2500 tokens.
     */
    tokenThreshold?: number;
    /** Maximum number of tools to return per search. Default: 5. */
    maxResults?: number;
    /**
     * Keep tools loaded after they are discovered via search.
     * When true, discovered tools remain active for the rest of the session.
     * When false, tools are deactivated after each turn.
     * Default: true.
     */
    keepLoadedTools?: boolean;
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
     * Trust gate: allow project-local MCP server definitions (.pizzapi/config.json) to be loaded.
     * Must be set in the GLOBAL ~/.pizzapi/config.json (or via
     * PIZZAPI_ALLOW_PROJECT_MCP=1 env var). Project configs cannot
     * self-authorize.
     *
     * When false/unset, project MCP servers are still loaded but a security
     * warning is printed. Set to true to suppress the warning.
     */
    allowProjectMcp?: boolean;

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
     * Global default `client_name` for MCP OAuth dynamic client registration.
     *
     * Some MCP servers (e.g. Figma) restrict registration to an allowlist of
     * known client names. Set this to a value the server accepts (e.g. `"Codex"`).
     *
     * Can also be set per-server via `oauthClientName` in individual
     * `mcpServers` entries — per-server values take precedence.
     *
     * Default: `"PizzaPi"`.
     */
    oauthClientName?: string;

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

    /**
     * Tool search configuration — dynamic MCP tool discovery.
     *
     * When enabled, defers MCP tools that exceed a token threshold
     * and provides a `search_tools` tool for on-demand discovery.
     *
     * Also supports per-server `deferLoading: true` in mcpServers entries.
     */
    toolSearch?: ToolSearchConfig;
}
