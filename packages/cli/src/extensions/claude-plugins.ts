/**
 * Claude Code Plugin Adapter — pi extension factory.
 *
 * Discovers Claude Code plugins from standard locations and registers
 * their commands and hooks into the pi-coding-agent runtime.
 *
 * This is the ExtensionFactory wrapper that integrates with PizzaPi's
 * extension system. The core parsing logic lives in ../plugins.ts.
 */
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import {
    discoverPlugins,
    resolvePluginRoot,
    matchesTool,
    mapHookEventToPi,
    scanPluginsDir,
    projectPluginDirs,
    type DiscoveredPlugin,
    type PluginCommand,
    type HookGroup,
    type ClaudeHookEvent,
    type HookEntry,
} from "../plugins.js";
import { isPluginTrusted, trustPlugin } from "../config.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// ── Hook executor ─────────────────────────────────────────────────────────────

interface HookExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * Execute a hook command via /bin/sh.
 *
 * Platform note: Claude Code plugins assume a POSIX shell environment.
 * This adapter targets macOS and Linux only (matching pi's supported
 * platforms). Windows support would require a different shell strategy.
 */
async function execHookCommand(
    command: string,
    pluginRoot: string,
    stdinData: Record<string, unknown>,
    timeoutMs: number = 10_000,
): Promise<HookExecResult> {
    const resolved = resolvePluginRoot(command, pluginRoot);

    return new Promise((resolveP) => {
        const child = execFile(
            "/bin/sh",
            ["-c", resolved],
            {
                timeout: timeoutMs,
                maxBuffer: 1024 * 256,
                cwd: pluginRoot,
                env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
            },
            (error, stdout, stderr) => {
                if (error) {
                    const isMaxBuffer =
                        (error as any).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
                        (error.message ?? "").includes("maxBuffer");
                    if (isMaxBuffer) {
                        console.warn(
                            `[claude-plugins] Hook stdout was truncated (maxBuffer exceeded) for command: ${command}. ` +
                            `A {"decision":"block"} at the end of large output may have been silently lost.`,
                        );
                    }
                }
                const exitCode = error && "code" in error ? (error as any).code ?? 1 : 0;
                resolveP({
                    stdout: typeof stdout === "string" ? stdout : "",
                    stderr: typeof stderr === "string" ? stderr : "",
                    exitCode: typeof exitCode === "number" ? exitCode : 1,
                });
            },
        );
        if (child.stdin) {
            try {
                child.stdin.write(JSON.stringify(stdinData));
                child.stdin.end();
            } catch { /* stdin may be closed */ }
        }
    });
}

// ── Template expansion ────────────────────────────────────────────────────────

/**
 * Expand `$ARGUMENTS`, `${ARGUMENTS}`, and `$ARGUMENTS[N]` placeholders
 * in a command template string.
 *
 * Positional `$ARGUMENTS[N]` placeholders are expanded FIRST so that the
 * broader `$ARGUMENTS` regex doesn't corrupt them (e.g. turning
 * `$ARGUMENTS[0]` into `"foo bar[0]"`).
 */
export function expandArguments(template: string, args: string | undefined): string {
    const argParts = (args ?? "").split(/\s+/).filter(Boolean);

    // 1. Positional first — $ARGUMENTS[0], $ARGUMENTS[1], …
    let result = template.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idx) => {
        return argParts[parseInt(idx, 10)] ?? "";
    });

    // 2. Global — $ARGUMENTS and ${ARGUMENTS}
    result = result
        .replace(/\$\{ARGUMENTS\}/g, args ?? "")
        .replace(/\$ARGUMENTS/g, args ?? "");

    return result;
}

// ── Command registration ──────────────────────────────────────────────────────

function registerPluginCommand(
    pi: ExtensionAPI,
    plugin: DiscoveredPlugin,
    cmd: PluginCommand,
): void {
    const commandName = `${plugin.name}:${cmd.name}`;
    const templateContent = resolvePluginRoot(cmd.content, plugin.rootPath);

    pi.registerCommand(commandName, {
        description: cmd.frontmatter.description ?? `[${plugin.name}] ${cmd.name}`,
        handler: async (args, ctx) => {
            let prompt = expandArguments(templateContent, args);

            // Resolve inline shell commands: !`command`
            const inlineShellPattern = /!\`([^`]+)\`/g;
            const inlineMatches = [...prompt.matchAll(inlineShellPattern)];
            for (const match of inlineMatches) {
                const shellCmd = match[1];
                try {
                    const result = await new Promise<string>((res) => {
                        execFile("/bin/sh", ["-c", shellCmd], {
                            timeout: 5000,
                            maxBuffer: 64 * 1024,
                            cwd: ctx.cwd,
                        }, (_err, stdout) => {
                            res(typeof stdout === "string" ? stdout.trim() : "");
                        });
                    });
                    prompt = prompt.replace(match[0], result);
                } catch { /* leave as-is */ }
            }

            pi.sendUserMessage(prompt);
        },
    });
}

// ── Hook registration ─────────────────────────────────────────────────────────

function registerPluginHooks(pi: ExtensionAPI, plugin: DiscoveredPlugin): void {
    if (!plugin.hooks) return;

    for (const [eventName, groups] of Object.entries(plugin.hooks.hooks)) {
        const claudeEvent = eventName as ClaudeHookEvent;
        const piEvent = mapHookEventToPi(claudeEvent);
        if (!piEvent) continue;
        if (!Array.isArray(groups)) continue;

        for (const group of groups as HookGroup[]) {
            if (!group || !Array.isArray(group.hooks)) continue;
            const commandHooks = group.hooks.filter(h => h && h.type === "command" && h.command);
            if (commandHooks.length === 0) continue;
            registerHookGroup(pi, plugin, claudeEvent, piEvent, group.matcher, commandHooks);
        }
    }
}

function registerHookGroup(
    pi: ExtensionAPI,
    plugin: DiscoveredPlugin,
    claudeEvent: ClaudeHookEvent,
    piEvent: string,
    matcher: string | undefined,
    hooks: HookEntry[],
): void {
    switch (piEvent) {
        case "tool_call":
            pi.on("tool_call", async (event, _ctx) => {
                if (!matchesTool(matcher, event.toolName, event.input as Record<string, unknown>)) return;
                const stdinData = {
                    session_id: "",
                    tool_name: event.toolName,
                    tool_input: event.input,
                    tool_call_id: event.toolCallId,
                };
                for (const hook of hooks) {
                    if (!hook.command) continue;
                    const result = await execHookCommand(hook.command, plugin.rootPath, stdinData, (hook.timeout ?? 10) * 1000);
                    if (result.exitCode === 2) {
                        return { block: true, reason: result.stderr.trim() || result.stdout.trim() || `Blocked by ${plugin.name}` };
                    }
                    if (result.stdout.trim()) {
                        try {
                            const output = JSON.parse(result.stdout.trim());
                            if (output.decision === "block" || output.hookSpecificOutput?.permissionDecision === "deny") {
                                return { block: true, reason: output.reason || output.hookSpecificOutput?.permissionDecisionReason || `Blocked by ${plugin.name}` };
                            }
                        } catch { /* not JSON */ }
                    }
                }
            });
            break;

        case "tool_result":
            pi.on("tool_result", async (event, _ctx) => {
                if (!matchesTool(matcher, event.toolName, event.input as Record<string, unknown>)) return;
                const isFailure = claudeEvent === "PostToolUseFailure";
                if (isFailure && !event.isError) return;
                if (claudeEvent === "PostToolUse" && event.isError) return;
                const stdinData = {
                    session_id: "",
                    tool_name: event.toolName,
                    tool_input: event.input,
                    tool_call_id: event.toolCallId,
                    tool_result: event.content,
                    is_error: event.isError,
                };
                for (const hook of hooks) {
                    if (!hook.command) continue;
                    await execHookCommand(hook.command, plugin.rootPath, stdinData, (hook.timeout ?? 10) * 1000);
                }
            });
            break;

        case "input":
            pi.on("input", async (event, _ctx) => {
                const stdinData = { session_id: "", prompt: event.text };
                for (const hook of hooks) {
                    if (!hook.command) continue;
                    const result = await execHookCommand(hook.command, plugin.rootPath, stdinData, (hook.timeout ?? 10) * 1000);
                    // Exit code 2 = block (same protocol as tool_call / session_before_compact)
                    if (result.exitCode === 2) {
                        const reason = result.stderr.trim() || result.stdout.trim() || `Blocked by ${plugin.name}`;
                        pi.sendUserMessage(reason, { deliverAs: "followUp" });
                        return { action: "handled" as const };
                    }
                    if (result.stdout.trim()) {
                        try {
                            const output = JSON.parse(result.stdout.trim());
                            if (output.decision === "block") {
                                const reason = output.reason || `Blocked by ${plugin.name}`;
                                pi.sendUserMessage(reason, { deliverAs: "followUp" });
                                return { action: "handled" as const };
                            }
                            if (output.transformedPrompt) return { action: "transform" as const, text: output.transformedPrompt };
                        } catch { /* not JSON */ }
                    }
                }
                return { action: "continue" as const };
            });
            break;

        case "agent_end":
            pi.on("agent_end", async (_event, _ctx) => {
                const stdinData = { session_id: "", stop_reason: "end_of_turn" };
                for (const hook of hooks) {
                    if (!hook.command) continue;
                    const result = await execHookCommand(hook.command, plugin.rootPath, stdinData, (hook.timeout ?? 10) * 1000);
                    if (result.stdout.trim()) {
                        try {
                            const output = JSON.parse(result.stdout.trim());
                            if (output.decision === "block" && output.reason) {
                                pi.sendUserMessage(output.reason, { deliverAs: "followUp" });
                            }
                        } catch { /* not JSON */ }
                    }
                }
            });
            break;

        case "session_start":
            pi.on("session_start", async (_event, ctx) => {
                const stdinData = { session_id: "" };
                for (const hook of hooks) {
                    if (!hook.command) continue;
                    const result = await execHookCommand(hook.command, plugin.rootPath, stdinData, (hook.timeout ?? 10) * 1000);
                    if (result.stdout.trim()) {
                        try {
                            const output = JSON.parse(result.stdout.trim());
                            const context = output.hookSpecificOutput?.additionalContext;
                            if (context) {
                                pi.sendMessage({
                                    customType: `plugin:${plugin.name}:session-context`,
                                    content: context,
                                    display: false,
                                }, { deliverAs: "nextTurn", triggerTurn: false });
                            }
                        } catch { /* not JSON */ }
                    }
                }
            });
            break;

        case "session_shutdown":
            pi.on("session_shutdown", async (_event, _ctx) => {
                const stdinData = { session_id: "" };
                for (const hook of hooks) {
                    if (!hook.command) continue;
                    await execHookCommand(hook.command, plugin.rootPath, stdinData, (hook.timeout ?? 10) * 1000);
                }
            });
            break;

        case "session_before_compact":
            pi.on("session_before_compact", async (_event, _ctx) => {
                const stdinData = { session_id: "" };
                for (const hook of hooks) {
                    if (!hook.command) continue;
                    const result = await execHookCommand(hook.command, plugin.rootPath, stdinData, (hook.timeout ?? 10) * 1000);
                    if (result.exitCode === 2) return { cancel: true };
                }
            });
            break;
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pluginSummary(p: DiscoveredPlugin): string {
    const parts: string[] = [p.name];
    if (p.commands.length) parts.push(`${p.commands.length} cmd${p.commands.length > 1 ? "s" : ""}`);
    if (p.hooks) {
        const hookCount = Object.values(p.hooks.hooks).flat().length;
        if (hookCount) parts.push(`${hookCount} hook${hookCount > 1 ? "s" : ""}`);
    }
    if (p.skills.length) parts.push(`${p.skills.length} skill${p.skills.length > 1 ? "s" : ""}`);
    if (p.rules.length) parts.push(`${p.rules.length} rule${p.rules.length > 1 ? "s" : ""}`);
    if (p.hasMcp) parts.push("mcp⚠️");
    return parts.join(": ");
}

function registerPlugin(pi: ExtensionAPI, plugin: DiscoveredPlugin): void {
    for (const cmd of plugin.commands) {
        registerPluginCommand(pi, plugin, cmd);
    }
    registerPluginHooks(pi, plugin);
    registerPluginRules(pi, plugin);
}

// ── Rules registration ────────────────────────────────────────────────────────

/**
 * Inject plugin rules into the system prompt via before_agent_start.
 * Rules are appended as a section at the end of the system prompt.
 */
function registerPluginRules(pi: ExtensionAPI, plugin: DiscoveredPlugin): void {
    if (plugin.rules.length === 0) return;

    // Build the rules block once
    const rulesBlock = plugin.rules
        .map(r => `## [${plugin.name}] ${r.name}\n\n${r.content}`)
        .join("\n\n");

    const section = `\n\n# Plugin Rules (${plugin.name})\n\n${rulesBlock}`;

    pi.on("before_agent_start", async (event, _ctx) => {
        return {
            systemPrompt: event.systemPrompt + section,
        };
    });
}

// ── Trust prompt event ────────────────────────────────────────────────────────

/**
 * Event payload emitted on `pi.events` when local plugins need user trust.
 *
 * The claude-plugins extension emits this; the remote extension (or any
 * other UI bridge) listens and surfaces the prompt to the user.
 *
 * The responder MUST call `respond(true/false)` exactly once. If no
 * listener responds within the timeout, the promise auto-rejects (skips).
 */
export interface PluginTrustPromptEvent {
    /** Unique ID to correlate prompt with response */
    promptId: string;
    /** Names of local plugins requesting trust */
    pluginNames: string[];
    /** Summaries for display */
    pluginSummaries: string[];
    /** Call exactly once with the user's decision */
    respond: (trusted: boolean) => void;
}

/** Timeout for trust prompt — if no UI responds in 60s, skip local plugins. */
const TRUST_PROMPT_TIMEOUT_MS = 60_000;

/**
 * Fire SessionStart hooks for a plugin immediately.
 *
 * Needed when plugins are registered inside an already-running session_start
 * handler — newly added listeners won't retroactively fire.
 */
async function fireSessionStartHooks(pi: ExtensionAPI, plugin: DiscoveredPlugin): Promise<void> {
    if (!plugin.hooks?.hooks.SessionStart) return;
    for (const group of plugin.hooks.hooks.SessionStart) {
        if (!group || !Array.isArray(group.hooks)) continue;
        for (const hook of group.hooks) {
            if (hook?.type !== "command" || !hook.command) continue;
            try {
                const result = await execHookCommand(
                    hook.command,
                    plugin.rootPath,
                    { session_id: "" },
                    (hook.timeout ?? 10) * 1000,
                );
                // Parse JSON output same as registerHookGroup session_start path
                if (result.stdout.trim()) {
                    try {
                        const output = JSON.parse(result.stdout.trim());
                        const context = output.hookSpecificOutput?.additionalContext;
                        if (context) {
                            pi.sendMessage({
                                customType: `plugin:${plugin.name}:session-context`,
                                content: context,
                                display: false,
                            }, { deliverAs: "nextTurn", triggerTurn: false });
                        }
                    } catch { /* not JSON */ }
                }
            } catch { /* best-effort */ }
        }
    }
}

// ── Extension factory ─────────────────────────────────────────────────────────

/**
 * Create a pi ExtensionFactory that discovers and loads Claude Code plugins.
 *
 * **Security model:**
 * - Global plugins (~/.pizzapi/plugins/, ~/.agents/plugins/, ~/.claude/plugins/)
 *   are auto-loaded at startup — they have the same trust level as global
 *   extensions or skills.
 * - Project-local plugins (.pizzapi/plugins/, .agents/plugins/, .claude/plugins/
 *   under cwd) can execute arbitrary shell commands via hooks. They are discovered
 *   at session start and require explicit user confirmation before loading.
 *
 * Trust prompt flow:
 * 1. In TUI interactive mode (ctx.hasUI), uses ctx.ui.confirm() directly.
 * 2. In headless/worker mode, emits a `plugin:trust_prompt` event on
 *    pi.events. The remote extension (or any other bridge) can listen for
 *    this and surface the prompt to the web viewer. If no listener responds
 *    within 60s, local plugins are skipped.
 *
 * Returns null if no global plugins are found AND no local dirs exist
 * (so the extension is not registered when there's nothing to do).
 */
export function createClaudePluginExtension(cwd: string): ExtensionFactory | null {
    // Discover global (trusted) plugins at factory creation time
    const globalPlugins = discoverPlugins(cwd);

    // Check if there are any project-local plugin dirs that might have content
    const localDirs = projectPluginDirs(cwd);
    const localPluginCandidates: DiscoveredPlugin[] = [];
    for (const dir of localDirs) {
        localPluginCandidates.push(...scanPluginsDir(dir));
    }
    // Deduplicate: remove local plugins that share a name with a global
    // plugin, and deduplicate among local dirs themselves (the same plugin
    // may exist under .pizzapi/plugins/, .agents/plugins/, .claude/plugins/).
    // When the same name appears in multiple local dirs, prefer the trusted
    // candidate so an untrusted duplicate doesn't shadow a trusted one.
    const globalNames = new Set(globalPlugins.map(p => p.name));
    const localByName = new Map<string, DiscoveredPlugin>();
    for (const p of localPluginCandidates) {
        if (globalNames.has(p.name)) continue;
        const existing = localByName.get(p.name);
        if (!existing) {
            localByName.set(p.name, p);
        } else if (!isPluginTrusted(existing.rootPath) && isPluginTrusted(p.rootPath)) {
            // Prefer the trusted candidate over the untrusted one
            localByName.set(p.name, p);
        }
        // Otherwise keep first occurrence (dir precedence)
    }
    const localOnly = Array.from(localByName.values());

    if (globalPlugins.length === 0 && localOnly.length === 0) return null;

    return (pi: ExtensionAPI) => {
        // Register global plugins immediately (trusted)
        for (const plugin of globalPlugins) {
            registerPlugin(pi, plugin);
        }

        // Track whether the trust prompt has been shown and answered (not
        // timed out) for this process lifetime. When true, we don't
        // re-prompt on subsequent session_start events — but we still
        // check for newly pre-trusted plugins each time.
        let trustPromptAnswered = false;
        // Track which local plugins have been registered (by rootPath) so
        // that plugins trusted mid-session (via `pizza plugins trust`) are
        // picked up on the next session_start without re-registering ones
        // already loaded.
        const registeredLocalPaths = new Set<string>();

        pi.on("session_start", async (_event, ctx) => {
            // Notify about global plugins
            if (globalPlugins.length > 0) {
                ctx.ui.notify(
                    `Loaded ${globalPlugins.length} Claude plugin${globalPlugins.length > 1 ? "s" : ""}: ${globalPlugins.map(pluginSummary).join(", ")}`,
                    "info",
                );
            }

            // No local plugins at all? Nothing more to do.
            if (localOnly.length === 0) return;

            // Split local plugins into pre-trusted (via `pizza plugins trust`)
            // and untrusted. Pre-trusted plugins load immediately without
            // prompting — same trust level as global plugins.
            const preTrusted = localOnly.filter(p => isPluginTrusted(p.rootPath));
            const untrusted = localOnly.filter(p => !isPluginTrusted(p.rootPath));

            // Load pre-trusted local plugins that haven't been registered yet.
            // This handles both the initial load and plugins that become
            // trusted mid-process (via `pizza plugins trust`) after a
            // previous timeout or rejection.
            const newPreTrusted = preTrusted.filter(p => !registeredLocalPaths.has(p.rootPath));
            if (newPreTrusted.length > 0) {
                for (const plugin of newPreTrusted) {
                    registerPlugin(pi, plugin);
                    registeredLocalPaths.add(plugin.rootPath);

                    // Fire SessionStart hooks immediately — we're already
                    // inside session_start so newly registered listeners
                    // won't retroactively fire. Await so hook output
                    // (e.g. initial context) is applied before the first
                    // user turn begins.
                    await fireSessionStartHooks(pi, plugin);
                }
                pi.events.emit("plugin:loaded", { count: newPreTrusted.length });
                ctx.ui.notify(
                    `Loaded ${newPreTrusted.length} trusted local plugin${newPreTrusted.length > 1 ? "s" : ""}: ${newPreTrusted.map(pluginSummary).join(", ")}`,
                    "info",
                );
            }

            // If there are no untrusted plugins left, we're done.
            // (All locals are either already registered or newly pre-trusted.)
            if (untrusted.length === 0) return;

            // User already answered the trust prompt this process? Don't
            // re-prompt — pre-trusted plugins were handled above, and the
            // remaining untrusted ones stay unloaded until process restart
            // or until the user runs `pizza plugins trust`.
            if (trustPromptAnswered) return;

            // Ask the user whether to trust the remaining plugins.
            // In TUI interactive mode, use ctx.ui.confirm() directly.
            // In headless/worker mode, emit a pi.events event so the
            // remote extension can bridge the prompt to the web viewer.
            let ok: boolean | "timeout" = false;
            const names = untrusted.map(p => p.name).join(", ");

            if (ctx.hasUI) {
                // TUI mode — direct confirmation dialog
                ok = await ctx.ui.confirm(
                    "Untrusted Claude Plugins",
                    `Found ${untrusted.length} project-local plugin${untrusted.length > 1 ? "s" : ""} (${names}). ` +
                    `These can execute shell commands via hooks.\n\nTrust and load them?`,
                );
            } else {
                // Headless/worker mode — emit trust prompt event for remote bridge
                const promptId = randomUUID();
                ok = await new Promise<boolean | "timeout">((resolve) => {
                    let settled = false;
                    const timer = setTimeout(() => {
                        if (!settled) {
                            settled = true;
                            // Notify listeners that the prompt expired so they
                            // can dismiss UI and clean up pending state.
                            pi.events.emit("plugin:trust_timeout", { promptId });
                            resolve("timeout");
                        }
                    }, TRUST_PROMPT_TIMEOUT_MS);

                    const promptEvent: PluginTrustPromptEvent = {
                        promptId,
                        pluginNames: untrusted.map(p => p.name),
                        pluginSummaries: untrusted.map(pluginSummary),
                        respond: (trusted: boolean) => {
                            if (settled) return;
                            settled = true;
                            clearTimeout(timer);
                            resolve(trusted);
                        },
                    };

                    pi.events.emit("plugin:trust_prompt", promptEvent);
                });
            }

            // Mark the trust prompt as answered on explicit user decision.
            // On timeout, allow re-prompting on next session_start so the
            // user gets another chance when a viewer is connected.
            // Note: pre-trusted plugins are always checked above regardless
            // of this flag, so `pizza plugins trust` works mid-process.
            if (ok !== "timeout") {
                trustPromptAnswered = true;
            }

            if (ok === true) {
                for (const plugin of untrusted) {
                    registerPlugin(pi, plugin);
                    registeredLocalPaths.add(plugin.rootPath);
                    // Persist trust so future sessions don't re-prompt
                    trustPlugin(plugin.rootPath);
                    // Await so hook output (e.g. initial context injection)
                    // completes before the session continues.
                    await fireSessionStartHooks(pi, plugin);
                }
                // Notify listeners (e.g. remote extension) so they can
                // re-send the capabilities snapshot to the web viewer.
                pi.events.emit("plugin:loaded", { count: untrusted.length });
                ctx.ui.notify(
                    `Loaded ${untrusted.length} local plugin${untrusted.length > 1 ? "s" : ""}: ${untrusted.map(pluginSummary).join(", ")}`,
                    "info",
                );
            } else {
                ctx.ui.notify(
                    `Skipped ${untrusted.length} untrusted local plugin${untrusted.length > 1 ? "s" : ""}. ` +
                    `Use \`pizza plugins trust\` to pre-approve.`,
                    "warning",
                );
            }
        });
    };
}

/**
 * Get the skill paths from all discovered Claude Code plugins.
 * Includes global plugins and any project-local plugins that are
 * already trusted (via `pizza plugins trust`).
 * Used by the worker to add plugin skills to pi's skill discovery.
 */
export function getPluginSkillPaths(cwd: string): string[] {
    // Start with global (auto-trusted) plugins
    const globalPlugins = discoverPlugins(cwd);
    const globalNames = new Set(globalPlugins.map(p => p.name));

    // Dedup local plugins with the same policy as createClaudePluginExtension:
    // prefer trusted candidate when same name appears in multiple dirs.
    // This ensures skills are sourced from the same plugin path that
    // would be used for commands/hooks registration.
    const localDirs = projectPluginDirs(cwd);
    const localByName = new Map<string, DiscoveredPlugin>();
    for (const dir of localDirs) {
        for (const plugin of scanPluginsDir(dir)) {
            if (globalNames.has(plugin.name)) continue;
            const existing = localByName.get(plugin.name);
            if (!existing) {
                localByName.set(plugin.name, plugin);
            } else if (!isPluginTrusted(existing.rootPath) && isPluginTrusted(plugin.rootPath)) {
                localByName.set(plugin.name, plugin);
            }
        }
    }
    // Only include trusted local plugins for skill loading
    const trustedLocal = Array.from(localByName.values()).filter(p => isPluginTrusted(p.rootPath));

    const paths: string[] = [];
    for (const plugin of [...globalPlugins, ...trustedLocal]) {
        if (plugin.skills.length > 0) {
            paths.push(join(plugin.rootPath, "skills"));
        }
    }
    return paths;
}

/**
 * Get the agent directory paths from all discovered Claude Code plugins.
 * Includes global plugins and any project-local plugins that are
 * already trusted (via `pizza plugins trust`).
 * Used by the subagent extension to discover plugin-provided agents.
 */
export function getPluginAgentPaths(cwd: string): string[] {
    // Start with global (auto-trusted) plugins
    const globalPlugins = discoverPlugins(cwd);
    const globalNames = new Set(globalPlugins.map(p => p.name));

    // Same dedup logic as getPluginSkillPaths — prefer trusted candidates.
    const localDirs = projectPluginDirs(cwd);
    const localByName = new Map<string, DiscoveredPlugin>();
    for (const dir of localDirs) {
        for (const plugin of scanPluginsDir(dir)) {
            if (globalNames.has(plugin.name)) continue;
            const existing = localByName.get(plugin.name);
            if (!existing) {
                localByName.set(plugin.name, plugin);
            } else if (!isPluginTrusted(existing.rootPath) && isPluginTrusted(plugin.rootPath)) {
                localByName.set(plugin.name, plugin);
            }
        }
    }
    const trustedLocal = Array.from(localByName.values()).filter(p => isPluginTrusted(p.rootPath));

    const paths: string[] = [];
    for (const plugin of [...globalPlugins, ...trustedLocal]) {
        if (plugin.agents.length > 0) {
            paths.push(join(plugin.rootPath, "agents"));
        }
    }
    return paths;
}
