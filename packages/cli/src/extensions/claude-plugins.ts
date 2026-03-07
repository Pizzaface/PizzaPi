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
import { execFile } from "node:child_process";

// ── Hook executor ─────────────────────────────────────────────────────────────

interface HookExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

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
            let prompt = templateContent
                .replace(/\$ARGUMENTS/g, args ?? "")
                .replace(/\$\{ARGUMENTS\}/g, args ?? "");

            const argParts = (args ?? "").split(/\s+/).filter(Boolean);
            prompt = prompt.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idx) => {
                return argParts[parseInt(idx, 10)] ?? "";
            });

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
                    if (result.stdout.trim()) {
                        try {
                            const output = JSON.parse(result.stdout.trim());
                            if (output.decision === "block") return { action: "handled" as const };
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
    if (p.hasMcp) parts.push("mcp⚠️");
    return parts.join(": ");
}

function registerPlugin(pi: ExtensionAPI, plugin: DiscoveredPlugin): void {
    for (const cmd of plugin.commands) {
        registerPluginCommand(pi, plugin, cmd);
    }
    registerPluginHooks(pi, plugin);
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
 *   In headless mode (no UI), project-local plugins are skipped.
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
    // Deduplicate against global plugins
    const globalNames = new Set(globalPlugins.map(p => p.name));
    const localOnly = localPluginCandidates.filter(p => !globalNames.has(p.name));

    if (globalPlugins.length === 0 && localOnly.length === 0) return null;

    return (pi: ExtensionAPI) => {
        // Register global plugins immediately (trusted)
        for (const plugin of globalPlugins) {
            registerPlugin(pi, plugin);
        }

        pi.on("session_start", async (_event, ctx) => {
            // Notify about global plugins
            if (globalPlugins.length > 0) {
                ctx.ui.notify(
                    `Loaded ${globalPlugins.length} Claude plugin${globalPlugins.length > 1 ? "s" : ""}: ${globalPlugins.map(pluginSummary).join(", ")}`,
                    "info",
                );
            }

            // Prompt for project-local plugins (interactive only)
            if (localOnly.length > 0 && ctx.hasUI) {
                const names = localOnly.map(p => p.name).join(", ");
                const ok = await ctx.ui.confirm(
                    "Untrusted Claude Plugins",
                    `Found ${localOnly.length} project-local plugin${localOnly.length > 1 ? "s" : ""} (${names}). ` +
                    `These can execute shell commands via hooks.\n\nTrust and load them?`,
                );

                if (ok) {
                    for (const plugin of localOnly) {
                        registerPlugin(pi, plugin);
                    }
                    ctx.ui.notify(
                        `Loaded ${localOnly.length} local plugin${localOnly.length > 1 ? "s" : ""}: ${localOnly.map(pluginSummary).join(", ")}`,
                        "info",
                    );
                } else {
                    ctx.ui.notify(
                        `Skipped ${localOnly.length} untrusted local plugin${localOnly.length > 1 ? "s" : ""}.`,
                        "warning",
                    );
                }
            } else if (localOnly.length > 0) {
                // Headless mode — skip local plugins silently
                ctx.ui.notify(
                    `Skipped ${localOnly.length} project-local plugin${localOnly.length > 1 ? "s" : ""} (headless mode — use global dirs for auto-loading).`,
                    "warning",
                );
            }
        });
    };
}

/**
 * Get the skill paths from all discovered Claude Code plugins.
 * Only includes global (trusted) plugin skill paths.
 * Used by the worker to add plugin skills to pi's skill discovery.
 */
export function getPluginSkillPaths(cwd: string): string[] {
    const plugins = discoverPlugins(cwd);
    const paths: string[] = [];
    for (const plugin of plugins) {
        if (plugin.skills.length > 0) {
            const skillsDir = plugin.rootPath + "/skills";
            paths.push(skillsDir);
        }
    }
    return paths;
}
