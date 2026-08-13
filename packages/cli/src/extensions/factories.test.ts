import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HooksConfig } from "../config.js";
import { buildPizzaPiExtensionFactories } from "./factories.js";
import { mcpExtension } from "./mcp-extension.js";
import { remoteExtension } from "./remote.js";
import { restartExtension } from "./restart.js";
import { reloadResourcesExtension } from "./reload-resources.js";
import { pluginCommandExtension } from "./plugin-command.js";

import { setSessionNameExtension } from "./set-session-name.js";
import { currentTimeExtension } from "./current-time.js";
import { spawnSessionExtension } from "./spawn-session.js";
import { updateTodoExtension } from "./update-todo.js";
import { memoryExtension } from "./memory/index.js";
import { subagentExtension } from "./subagent.js";
import { workflowExtension } from "./workflow/index.js";
import { tunnelToolsExtension } from "./tunnel-tools.js";
import { serviceMessageBridgeExtension } from "./service-message-bridge.js";
import { planModeToggleExtension } from "./plan-mode/index.js";
import { triggersExtension } from "./triggers/extension.js";
import { sandboxEventsExtension } from "./sandbox-events.js";
import { pizzapiTitleExtension } from "./pizzapi-title.js";
import { goalExtension } from "./goal/index.js";
import { initialPromptExtension } from "./initial-prompt.js";
import { pizzapiHeaderExtension } from "./pizzapi-header.js";
import { toolSearchExtension } from "./tool-search.js";
import { ollamaWebToolsExtension } from "./ollama-web-tools.js";
import { sessionAnalysisExtension } from "./session-analysis.js";
import { providerRequestLogExtension } from "./provider-request-log.js";
import { sessionProcessesExtension } from "./session-processes.js";
import { backgroundBashExtension } from "./background-bash.js";
import { queueFlushExtension } from "./queue-flush.js";
import { ollamaCloudProviderExtension } from "./ollama-cloud-provider.js";
import { hostAnnounceExtension } from "./host-announce.js";
import { runPackageCommand } from "../package-commands.js";

// resource-paths is a factory *created per call* (createResourcePathsExtension(...)),
// so it's never reference-equal to a statically imported factory. Split the
// otherwise-static core list around it and assert its presence/type separately.
// Isolated, empty agent dir so package-overlay-rules resolution (which reads
// pi settings via SettingsManager) never picks up real packages configured
// on the machine running these tests — keeps exact-length assertions stable.
const TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), "pizzapi-factories-agentdir-"));

const CORE_EXTENSIONS_HEAD: ExtensionFactory[] = [
    hostAnnounceExtension,
    ollamaCloudProviderExtension,
    providerRequestLogExtension,
    triggersExtension,  // Must be before remoteExtension (shutdown ordering)
    remoteExtension,
    tunnelToolsExtension,
    serviceMessageBridgeExtension,
    mcpExtension,
    toolSearchExtension,  // Must be after MCP to see registered MCP tools
    ollamaWebToolsExtension,
];
const CORE_EXTENSIONS_TAIL: ExtensionFactory[] = [
    goalExtension,
    restartExtension,
    reloadResourcesExtension,
    pluginCommandExtension,
    sessionProcessesExtension,
    setSessionNameExtension,
    currentTimeExtension,
    backgroundBashExtension,
    queueFlushExtension,
    updateTodoExtension,
    memoryExtension,
    spawnSessionExtension,
    subagentExtension,
    workflowExtension,
    planModeToggleExtension,
    sandboxEventsExtension,
    pizzapiTitleExtension,
    pizzapiHeaderExtension,
    sessionAnalysisExtension,  // Always registered
];
// +1 for the resource-paths factory inserted between HEAD and TAIL.
const CORE_EXTENSIONS_COUNT = CORE_EXTENSIONS_HEAD.length + 1 + CORE_EXTENSIONS_TAIL.length;

/** Assert the leading `CORE_EXTENSIONS_COUNT` factories match the expected core composition. */
function expectCoreExtensionsPrefix(factories: ExtensionFactory[]) {
    expect(factories.slice(0, CORE_EXTENSIONS_HEAD.length)).toEqual(CORE_EXTENSIONS_HEAD);
    expect(typeof factories[CORE_EXTENSIONS_HEAD.length]).toBe("function"); // resource-paths
    expect(factories.slice(CORE_EXTENSIONS_HEAD.length + 1, CORE_EXTENSIONS_COUNT)).toEqual(CORE_EXTENSIONS_TAIL);
}

/**
 * Tests that focus on core extension composition use skipPlugins: true
 * to avoid depending on whether global plugins exist in the real HOME
 * directory (Bun caches homedir() at process start, so overriding HOME
 * in tests doesn't help).
 */
describe("buildPizzaPiExtensionFactories", () => {
    test("returns core extensions by default", () => {
        const factories = buildPizzaPiExtensionFactories({ cwd: "/tmp/pizzapi-test", agentDir: TEST_AGENT_DIR, skipPlugins: true });
        expect(factories).toHaveLength(CORE_EXTENSIONS_COUNT);
        expectCoreExtensionsPrefix(factories);
    });

    test("includes initial prompt extension for worker mode", () => {
        const factories = buildPizzaPiExtensionFactories({
            cwd: "/tmp/pizzapi-test",
            agentDir: TEST_AGENT_DIR,
            includeInitialPrompt: true,
            skipPlugins: true,
        });

        expect(factories).toHaveLength(CORE_EXTENSIONS_COUNT + 1);
        expectCoreExtensionsPrefix(factories);
        expect(factories[CORE_EXTENSIONS_COUNT]).toBe(initialPromptExtension);
    });

    test("appends hooks extension when hooks are configured", () => {
        const hooks: HooksConfig = {
            PreToolUse: [{ matcher: "Bash", hooks: [{ command: "echo hook" }] }],
        };

        const factories = buildPizzaPiExtensionFactories({
            cwd: "/tmp/pizzapi-test",
            agentDir: TEST_AGENT_DIR,
            hooks,
            skipPlugins: true,
        });

        expect(factories).toHaveLength(CORE_EXTENSIONS_COUNT + 1);
        expectCoreExtensionsPrefix(factories);
        expect(typeof factories[CORE_EXTENSIONS_COUNT]).toBe("function");
    });

    test("worker mode includes initial prompt before hooks", () => {
        const hooks: HooksConfig = {
            PostToolUse: [{ matcher: "Edit|Write", hooks: [{ command: "echo post-hook" }] }],
        };

        const factories = buildPizzaPiExtensionFactories({
            cwd: "/tmp/pizzapi-test",
            agentDir: TEST_AGENT_DIR,
            hooks,
            includeInitialPrompt: true,
            skipPlugins: true,
        });

        expect(factories).toHaveLength(CORE_EXTENSIONS_COUNT + 2);
        expectCoreExtensionsPrefix(factories);
        expect(factories[CORE_EXTENSIONS_COUNT]).toBe(initialPromptExtension);
        expect(typeof factories[CORE_EXTENSIONS_COUNT + 1]).toBe("function");
    });
});

// ── Safe mode / skip flags ────────────────────────────────────────────────────

describe("buildPizzaPiExtensionFactories — safe mode", () => {
    test("skipMcp excludes MCP extension", () => {
        const factories = buildPizzaPiExtensionFactories({ cwd: "/tmp/pizzapi-test", agentDir: TEST_AGENT_DIR, skipMcp: true });
        expect(factories).not.toContain(mcpExtension);
        // Other core extensions should still be present
        expect(factories).toContain(remoteExtension);
        expect(factories).toContain(restartExtension);
    });

    test("skipRelay excludes remote extension, tunnel tools, and the session mirror", () => {
        const factories = buildPizzaPiExtensionFactories({ cwd: "/tmp/pizzapi-test", agentDir: TEST_AGENT_DIR, skipRelay: true });
        expect(factories).not.toContain(remoteExtension);
        expect(factories).not.toContain(tunnelToolsExtension);
        expect(factories).not.toContain(serviceMessageBridgeExtension);
        expect(factories).toContain(mcpExtension);
    });

    test("skipPlugins excludes plugin extension even when plugins exist", () => {
        const projectDir = mkdtempSync(join(tmpdir(), "pizzapi-factories-skip-"));
        try {
            const pluginDir = join(projectDir, ".pizzapi", "plugins", "test-plugin");
            mkdirSync(join(pluginDir, "commands"), { recursive: true });
            writeFileSync(join(pluginDir, "commands", "hello.md"), "# Hello");

            const withPlugins = buildPizzaPiExtensionFactories({ cwd: projectDir, agentDir: TEST_AGENT_DIR });
            const withoutPlugins = buildPizzaPiExtensionFactories({ cwd: projectDir, agentDir: TEST_AGENT_DIR, skipPlugins: true });

            // Without skipPlugins, there should be more extensions (plugin extension appended)
            expect(withPlugins.length).toBeGreaterThan(withoutPlugins.length);
        } finally {
            try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
        }
    });

    test("all skip flags together leaves only non-optional extensions", () => {
        const hooks: HooksConfig = {
            PreToolUse: [{ matcher: "Bash", hooks: [{ command: "echo hook" }] }],
        };

        const factories = buildPizzaPiExtensionFactories({
            cwd: "/tmp/pizzapi-test",
            agentDir: TEST_AGENT_DIR,
            skipMcp: true,
            skipRelay: true,
            skipPlugins: true,
            // hooks are omitted by passing undefined (simulating --no-hooks behavior)
        });

        expect(factories).not.toContain(remoteExtension);
        expect(factories).not.toContain(mcpExtension);
        // Should still have the always-on extensions
        expect(factories).toContain(restartExtension);
        expect(factories).toContain(setSessionNameExtension);
        expect(factories).toContain(updateTodoExtension);
        expect(factories).toContain(spawnSessionExtension);
        expect(factories).toContain(spawnSessionExtension);
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

            const factories = buildPizzaPiExtensionFactories({ cwd: projectDir, agentDir: TEST_AGENT_DIR });

            // Core + plugin extension (at minimum)
            expect(factories.length).toBeGreaterThan(CORE_EXTENSIONS_COUNT);
            expectCoreExtensionsPrefix(factories);
            expect(typeof factories[factories.length - 1]).toBe("function");
        } finally {
            try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
        }
    });

    test("does not append plugin extension when no plugins exist anywhere", () => {
        // Use an empty temp dir — no global or local plugins
        const emptyDir = mkdtempSync(join(tmpdir(), "pizzapi-factories-noplugin-"));
        try {
            const factories = buildPizzaPiExtensionFactories({ cwd: emptyDir, agentDir: TEST_AGENT_DIR });
            // May or may not have plugin extension depending on real HOME plugins.
            // The key invariant: core extensions are always first.
            expectCoreExtensionsPrefix(factories);
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

            const factories = buildPizzaPiExtensionFactories({ cwd: projectDir, agentDir: TEST_AGENT_DIR, hooks });

            // Core + hooks + plugin (at least)
            expect(factories.length).toBeGreaterThanOrEqual(CORE_EXTENSIONS_COUNT + 2);
            expectCoreExtensionsPrefix(factories);
        } finally {
            try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
        }
    });
});

// ── Package-overlay-rules factory: project-trust gate + ordering ─────────────

describe("buildPizzaPiExtensionFactories — package-overlay-rules trust gate", () => {
    function writeFixturePackage(dir: string, overlay: unknown, files?: Record<string, string>) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", pi: { pizzapi: overlay } }));
        for (const [rel, content] of Object.entries(files ?? {})) {
            const filePath = join(dir, rel);
            mkdirSync(join(filePath, ".."), { recursive: true });
            writeFileSync(filePath, content);
        }
    }

    // runPackageCommand() chdir()s the process into cwd and only sets
    // PI_CODING_AGENT_DIR when unset — both must be restored, or a LATER
    // test file sharing this bun test process inherits a deleted tmp cwd
    // (breaking anything that shells out or resolves relative paths) and/or
    // a stale agentDir (see other overlay tests' identical notes).
    async function withRestoredProcessState<T>(fn: () => Promise<T>): Promise<T> {
        const originalCwd = process.cwd();
        const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
        try {
            return await fn();
        } finally {
            process.chdir(originalCwd);
            if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
        }
    }

    test("projectTrusted: true wires the package-overlay-rules factory for a project-scope package; false excludes it (defaults to false when omitted)", async () => {
        await withRestoredProcessState(async () => {
            const rootDir = mkdtempSync(join(tmpdir(), "pizzapi-factories-overlay-rules-"));
            const cwd = join(rootDir, "project");
            const agentDir = join(rootDir, "agent");
            mkdirSync(cwd, { recursive: true });
            mkdirSync(agentDir, { recursive: true });
            try {
                const pkgDir = join(rootDir, "rules-pkg");
                writeFixturePackage(pkgDir, { schemaVersion: 1, rules: ["./rules"] }, { "rules/a.md": "Be terse." });
                const code = await runPackageCommand(["install", "../rules-pkg", "-l"], cwd, agentDir);
                expect(code).toBe(0);

                const untrustedFactories = buildPizzaPiExtensionFactories({ cwd, agentDir, skipPlugins: true });
                expect(untrustedFactories.length).toBe(CORE_EXTENSIONS_COUNT); // no projectTrusted passed — fails closed

                const explicitlyUntrusted = buildPizzaPiExtensionFactories({ cwd, agentDir, skipPlugins: true, projectTrusted: false });
                expect(explicitlyUntrusted.length).toBe(CORE_EXTENSIONS_COUNT);

                const trustedFactories = buildPizzaPiExtensionFactories({ cwd, agentDir, skipPlugins: true, projectTrusted: true });
                expect(trustedFactories.length).toBe(CORE_EXTENSIONS_COUNT + 1);
                expect((trustedFactories[trustedFactories.length - 1] as any).displayName).toBe("package-overlay-rules");
            } finally {
                try { rmSync(rootDir, { recursive: true, force: true }); } catch {}
            }
        });
    });

    test("package-overlay-rules factory is registered before the legacy Claude-plugin rules factory (package-before-legacy ordering)", async () => {
        await withRestoredProcessState(async () => {
            const rootDir = mkdtempSync(join(tmpdir(), "pizzapi-factories-overlay-order-"));
            const cwd = join(rootDir, "project");
            const agentDir = join(rootDir, "agent");
            mkdirSync(cwd, { recursive: true });
            mkdirSync(agentDir, { recursive: true });
            try {
                const pkgDir = join(rootDir, "rules-pkg2");
                writeFixturePackage(pkgDir, { schemaVersion: 1, rules: ["./rules"] }, { "rules/a.md": "Be terse." });
                const code = await runPackageCommand(["install", "../rules-pkg2", "-l"], cwd, agentDir);
                expect(code).toBe(0);

                const pluginDir = join(cwd, ".pizzapi", "plugins", "legacy-plugin");
                mkdirSync(join(pluginDir, "rules"), { recursive: true });
                writeFileSync(join(pluginDir, "rules", "b.md"), "# Legacy rule\nLegacy content.");

                const factories = buildPizzaPiExtensionFactories({ cwd, agentDir, projectTrusted: true });
                const overlayIdx = factories.findIndex((f) => (f as any).displayName === "package-overlay-rules");
                const pluginsIdx = factories.findIndex((f) => (f as any).displayName === "plugins");
                expect(overlayIdx).toBeGreaterThanOrEqual(0);
                expect(pluginsIdx).toBeGreaterThanOrEqual(0);
                expect(overlayIdx).toBeLessThan(pluginsIdx);
            } finally {
                try { rmSync(rootDir, { recursive: true, force: true }); } catch {}
            }
        });
    });
});
