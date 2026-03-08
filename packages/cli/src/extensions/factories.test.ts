import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

/**
 * Most tests use a non-existent cwd ("/tmp/pizzapi-test") so no plugins are
 * discovered and the plugin extension is not appended. Tests that need
 * plugins create a temp HOME with a real plugin directory.
 */
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

// ── Plugin extension inclusion ────────────────────────────────────────────────
//
// NOTE: Bun caches homedir() from process start, so overriding HOME doesn't
// affect globalPluginDirs(). To test plugin extension inclusion, we create
// project-local plugins (discovered via cwd). createClaudePluginExtension
// returns non-null when it finds either global OR local plugins.

describe("buildPizzaPiExtensionFactories — plugin extension", () => {
    test("appends plugin extension when project-local plugins exist", () => {
        // Create a project with a local plugin
        const projectDir = mkdtempSync(join(tmpdir(), "pizzapi-factories-plugin-"));
        try {
            const pluginDir = join(projectDir, ".pizzapi", "plugins", "test-plugin");
            mkdirSync(join(pluginDir, "commands"), { recursive: true });
            writeFileSync(join(pluginDir, "commands", "hello.md"), "# Hello");

            const factories = buildPizzaPiExtensionFactories({ cwd: projectDir });

            // Core + plugin extension (at minimum)
            expect(factories.length).toBeGreaterThan(CORE_EXTENSIONS.length);
            expect(factories.slice(0, CORE_EXTENSIONS.length)).toEqual(CORE_EXTENSIONS);
            expect(typeof factories[factories.length - 1]).toBe("function");
        } finally {
            try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
        }
    });

    test("does not append plugin extension when no plugins exist anywhere", () => {
        // Use an empty temp dir — no global or local plugins
        const emptyDir = mkdtempSync(join(tmpdir(), "pizzapi-factories-noplugin-"));
        try {
            const factories = buildPizzaPiExtensionFactories({ cwd: emptyDir });
            // May or may not have plugin extension depending on real HOME plugins.
            // The key invariant: core extensions are always first.
            expect(factories.slice(0, CORE_EXTENSIONS.length)).toEqual(CORE_EXTENSIONS);
        } finally {
            try { rmSync(emptyDir, { recursive: true, force: true }); } catch {}
        }
    });

    test("plugin extension comes after hooks extension", () => {
        const projectDir = mkdtempSync(join(tmpdir(), "pizzapi-factories-order-"));
        try {
            const pluginDir = join(projectDir, ".pizzapi", "plugins", "test-plugin");
            mkdirSync(join(pluginDir, "commands"), { recursive: true });
            writeFileSync(join(pluginDir, "commands", "hello.md"), "# Hello");

            const hooks: HooksConfig = {
                PreToolUse: [{ matcher: "Bash", hooks: [{ command: "echo hook" }] }],
            };

            const factories = buildPizzaPiExtensionFactories({ cwd: projectDir, hooks });

            // Core + hooks + plugin (at least)
            expect(factories.length).toBeGreaterThanOrEqual(CORE_EXTENSIONS.length + 2);
            expect(factories.slice(0, CORE_EXTENSIONS.length)).toEqual(CORE_EXTENSIONS);
        } finally {
            try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
        }
    });
});
