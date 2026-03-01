import { describe, expect, test } from "bun:test";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { HooksConfig } from "../config.js";
import { buildPizzaPiExtensionFactories } from "./factories.js";
import { mcpExtension } from "./mcp-extension.js";
import { remoteExtension } from "./remote.js";
import { restartExtension } from "./restart.js";
import { sessionMessagingExtension } from "./session-messaging.js";
import { setSessionNameExtension } from "./set-session-name.js";
import { spawnSessionExtension } from "./spawn-session.js";
import { updateTodoExtension } from "./update-todo.js";
import { initialPromptExtension } from "./initial-prompt.js";

const CORE_EXTENSIONS: ExtensionFactory[] = [
    remoteExtension,
    mcpExtension,
    restartExtension,
    setSessionNameExtension,
    updateTodoExtension,
    spawnSessionExtension,
    sessionMessagingExtension,
];

describe("buildPizzaPiExtensionFactories", () => {
    test("returns core extensions by default", () => {
        const factories = buildPizzaPiExtensionFactories({ cwd: "/tmp/pizzapi-test" });
        expect(factories).toEqual(CORE_EXTENSIONS);
    });

    test("includes initial prompt extension for worker mode", () => {
        const factories = buildPizzaPiExtensionFactories({
            cwd: "/tmp/pizzapi-test",
            includeInitialPrompt: true,
        });

        expect(factories).toEqual([...CORE_EXTENSIONS, initialPromptExtension]);
    });

    test("appends hooks extension when hooks are configured", () => {
        const hooks: HooksConfig = {
            PreToolUse: [{ matcher: "Bash", hooks: [{ command: "echo hook" }] }],
        };

        const factories = buildPizzaPiExtensionFactories({
            cwd: "/tmp/pizzapi-test",
            hooks,
        });

        expect(factories).toHaveLength(CORE_EXTENSIONS.length + 1);
        expect(factories.slice(0, CORE_EXTENSIONS.length)).toEqual(CORE_EXTENSIONS);
        expect(typeof factories[CORE_EXTENSIONS.length]).toBe("function");
    });

    test("worker mode includes initial prompt before hooks", () => {
        const hooks: HooksConfig = {
            PostToolUse: [{ matcher: "Edit|Write", hooks: [{ command: "echo post-hook" }] }],
        };

        const factories = buildPizzaPiExtensionFactories({
            cwd: "/tmp/pizzapi-test",
            hooks,
            includeInitialPrompt: true,
        });

        expect(factories).toHaveLength(CORE_EXTENSIONS.length + 2);
        expect(factories.slice(0, CORE_EXTENSIONS.length)).toEqual(CORE_EXTENSIONS);
        expect(factories[CORE_EXTENSIONS.length]).toBe(initialPromptExtension);
        expect(typeof factories[CORE_EXTENSIONS.length + 1]).toBe("function");
    });
});
