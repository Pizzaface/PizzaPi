import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { HooksConfig } from "../config.js";
import { createHooksExtension } from "./hooks.js";
import { initialPromptExtension } from "./initial-prompt.js";
import { mcpExtension } from "./mcp-extension.js";
import { remoteExtension } from "./remote.js";
import { restartExtension } from "./restart.js";
import { sessionMessagingExtension } from "./session-messaging.js";
import { setSessionNameExtension } from "./set-session-name.js";
import { spawnSessionExtension } from "./spawn-session.js";
import { updateTodoExtension } from "./update-todo.js";
import { createClaudePluginExtension } from "./claude-plugins.js";
import { subagentExtension } from "./subagent.js";
import { planModeToggleExtension } from "./plan-mode-toggle.js";
import { triggersExtension } from "./triggers/extension.js";

export interface BuildExtensionFactoriesOptions {
    cwd: string;
    hooks?: HooksConfig;
    includeInitialPrompt?: boolean;
    /** Skip MCP server connections (safe mode). */
    skipMcp?: boolean;
    /** Skip Claude Code plugin discovery (safe mode). */
    skipPlugins?: boolean;
    /** Skip relay server connection (safe mode). */
    skipRelay?: boolean;
}

/**
 * Build the standard PizzaPi extension factory list.
 *
 * Shared by interactive CLI and runner worker mode so capabilities stay in sync.
 */
export function buildPizzaPiExtensionFactories(options: BuildExtensionFactoriesOptions): ExtensionFactory[] {
    const factories: ExtensionFactory[] = [];

    // triggersExtension MUST be registered before remoteExtension so its
    // session_shutdown handler fires first — sending the session_complete
    // trigger while the relay socket is still connected.
    factories.push(triggersExtension);

    if (!options.skipRelay) {
        factories.push(remoteExtension);
    }

    if (!options.skipMcp) {
        factories.push(mcpExtension);
    }

    factories.push(
        restartExtension,
        setSessionNameExtension,
        updateTodoExtension,
        spawnSessionExtension,
        sessionMessagingExtension,
        subagentExtension,
        planModeToggleExtension,
    );

    if (options.includeInitialPrompt) {
        factories.push(initialPromptExtension);
    }

    const hooksExtension = createHooksExtension(options.hooks, options.cwd);
    if (hooksExtension) {
        factories.push(hooksExtension);
    }

    // Claude Code plugin adapter — discovers and loads plugins from standard dirs
    if (!options.skipPlugins) {
        const pluginExtension = createClaudePluginExtension(options.cwd);
        if (pluginExtension) {
            factories.push(pluginExtension);
        }
    }

    return factories;
}
