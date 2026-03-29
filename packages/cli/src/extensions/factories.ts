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
import { tunnelToolsExtension } from "./tunnel-tools.js";
import { planModeToggleExtension } from "./plan-mode/index.js";
import { triggersExtension } from "./triggers/extension.js";
import { sandboxEventsExtension } from "./sandbox-events.js";
import { pizzapiTitleExtension } from "./pizzapi-title.js";
import { pizzapiHeaderExtension } from "./pizzapi-header.js";

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

/** Tag a factory with a display name for the boot info listing. */
function named(factory: ExtensionFactory, displayName: string): ExtensionFactory {
    (factory as any).displayName = displayName;
    return factory;
}

/**
 * Build the standard PizzaPi extension factory list.
 *
 * Shared by interactive CLI and runner worker mode so capabilities stay in sync.
 */
export function buildPizzaPiExtensionFactories(options: BuildExtensionFactoriesOptions): ExtensionFactory[] {
    const factories: ExtensionFactory[] = [];

    // triggersExtension provides tell_child, respond_to_trigger, escalate_trigger tools.
    // session_complete is fired from remoteExtension's shutdown handler (before disconnect).
    factories.push(named(triggersExtension, "triggers"));

    if (!options.skipRelay) {
        factories.push(named(remoteExtension, "relay"));
        factories.push(named(tunnelToolsExtension, "tunnel-tools"));
    }

    if (!options.skipMcp) {
        factories.push(named(mcpExtension, "mcp"));
    }

    factories.push(
        named(restartExtension, "restart"),
        named(setSessionNameExtension, "session-name"),
        named(updateTodoExtension, "todo"),
        named(spawnSessionExtension, "spawn-session"),
        named(sessionMessagingExtension, "messaging"),
        named(subagentExtension, "subagent"),
        named(planModeToggleExtension, "plan-mode"),
        named(sandboxEventsExtension, "sandbox"),
        named(pizzapiTitleExtension, "title"),
        named(pizzapiHeaderExtension, "header"),
    );

    if (options.includeInitialPrompt) {
        factories.push(named(initialPromptExtension, "initial-prompt"));
    }

    const hooksExtension = createHooksExtension(options.hooks, options.cwd);
    if (hooksExtension) {
        factories.push(named(hooksExtension, "hooks"));
    }

    // Claude Code plugin adapter — discovers and loads plugins from standard dirs
    if (!options.skipPlugins) {
        const pluginExtension = createClaudePluginExtension(options.cwd);
        if (pluginExtension) {
            factories.push(named(pluginExtension, "plugins"));
        }
    }

    return factories;
}
