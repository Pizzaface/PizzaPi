import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { HooksConfig } from "../config.js";
import { conversationTriggersExtension } from "./conversation-triggers.js";
import { createHooksExtension } from "./hooks.js";
import { initialPromptExtension } from "./initial-prompt.js";
import { mcpExtension } from "./mcp-extension.js";
import { remoteExtension } from "./remote.js";
import { restartExtension } from "./restart.js";
import { sessionMessagingExtension } from "./session-messaging.js";
import { setSessionNameExtension } from "./set-session-name.js";
import { spawnSessionExtension } from "./spawn-session.js";
import { updateTodoExtension } from "./update-todo.js";

export interface BuildExtensionFactoriesOptions {
    cwd: string;
    hooks?: HooksConfig;
    includeInitialPrompt?: boolean;
}

/**
 * Build the standard PizzaPi extension factory list.
 *
 * Shared by interactive CLI and runner worker mode so capabilities stay in sync.
 */
export function buildPizzaPiExtensionFactories(options: BuildExtensionFactoriesOptions): ExtensionFactory[] {
    const factories: ExtensionFactory[] = [
        remoteExtension,
        mcpExtension,
        restartExtension,
        setSessionNameExtension,
        updateTodoExtension,
        spawnSessionExtension,
        sessionMessagingExtension,
        conversationTriggersExtension,
    ];

    if (options.includeInitialPrompt) {
        factories.push(initialPromptExtension);
    }

    const hooksExtension = createHooksExtension(options.hooks, options.cwd);
    if (hooksExtension) {
        factories.push(hooksExtension);
    }

    return factories;
}
