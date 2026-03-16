/**
 * Patch compatibility tests for @mariozechner/pi-coding-agent and @mariozechner/pi-ai.
 *
 * These tests verify that the bun patches applied to upstream pi packages
 * are correctly in place and the patched APIs function as expected.
 *
 * If these tests fail after a version bump, you need to recreate the patches.
 * See patches/README.md for details.
 */
import { describe, test, expect } from "bun:test";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Resolve a deep path inside @mariozechner/pi-coding-agent.
 * The package only exports "." and "./hooks", so we resolve from
 * the package root on disk.
 */
function piCodingAgentPath(subpath: string): string {
    const pkgMainUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
    const pkgMain = fileURLToPath(pkgMainUrl);
    // pkgMain → .../dist/index.js, package root is two dirs up
    const pkgRoot = resolve(dirname(pkgMain), "..");
    return resolve(pkgRoot, subpath);
}

/**
 * Resolve a deep path inside @mariozechner/pi-ai.
 */
function piAiPath(subpath: string): string {
    const pkgMainUrl = import.meta.resolve("@mariozechner/pi-ai");
    const pkgMain = fileURLToPath(pkgMainUrl);
    const pkgRoot = resolve(dirname(pkgMain), "..");
    return resolve(pkgRoot, subpath);
}

// ===========================================================================
// pi-coding-agent patches
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Patch presence — verify patched source contains expected code
// ---------------------------------------------------------------------------

describe("pi-coding-agent patch application", () => {
    test("loader.js: createExtensionRuntime exposes newSession/switchSession stubs", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/core/extensions/loader.js"),
        ).text();

        // Runtime stubs
        expect(source).toContain("newSession");
        expect(source).toContain("switchSession");
        // Our patch markers
        expect(source).toContain("PATCH(pizzapi)");
    });

    test("loader.js: createExtensionAPI exposes newSession/switchSession methods", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/core/extensions/loader.js"),
        ).text();

        // The API should delegate to runtime.newSession / runtime.switchSession
        expect(source).toContain("runtime.newSession");
        expect(source).toContain("runtime.switchSession");
    });

    test("runner.js: bindCommandContext copies handlers onto runtime", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/core/extensions/runner.js"),
        ).text();

        // The patch assigns the handlers to this.runtime
        expect(source).toContain("this.runtime.newSession");
        expect(source).toContain("this.runtime.switchSession");
        expect(source).toContain("PATCH(pizzapi)");
    });

    test("interactive-mode.js: version check call is removed from run()", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/modes/interactive/interactive-mode.js"),
        ).text();

        // The run() method should NOT contain the version check invocation
        const runMethodStart = source.indexOf("async run()");
        expect(runMethodStart).not.toBe(-1);
        const runMethod = source.slice(runMethodStart, runMethodStart + 500);
        expect(runMethod).not.toContain("checkForNewVersion");
    });

    test("interactive-mode.js: checkForNewVersion method is removed", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/modes/interactive/interactive-mode.js"),
        ).text();

        expect(source).not.toContain("async checkForNewVersion()");
        expect(source).not.toContain("showNewVersionNotification");
    });
});

// ---------------------------------------------------------------------------
// 2. Functional — verify patched runtime/API objects behave correctly
// ---------------------------------------------------------------------------

describe("pi-coding-agent patched runtime behavior", () => {
    test("createExtensionRuntime returns object with newSession/switchSession", async () => {
        const { createExtensionRuntime } = await import(
            piCodingAgentPath("dist/core/extensions/loader.js")
        );
        const runtime = createExtensionRuntime();

        expect(typeof runtime.newSession).toBe("function");
        expect(typeof runtime.switchSession).toBe("function");
    });

    test("runtime.newSession rejects before initialization", async () => {
        const { createExtensionRuntime } = await import(
            piCodingAgentPath("dist/core/extensions/loader.js")
        );
        const runtime = createExtensionRuntime();

        await expect(runtime.newSession()).rejects.toThrow(/not initialized/i);
    });

    test("runtime.switchSession rejects before initialization", async () => {
        const { createExtensionRuntime } = await import(
            piCodingAgentPath("dist/core/extensions/loader.js")
        );
        const runtime = createExtensionRuntime();

        await expect(runtime.switchSession("/some/path")).rejects.toThrow(/not initialized/i);
    });

    test("runtime.newSession/switchSession are assignable (runner can bind them)", async () => {
        const { createExtensionRuntime } = await import(
            piCodingAgentPath("dist/core/extensions/loader.js")
        );
        const runtime = createExtensionRuntime();

        // Simulate what runner.js bindCommandContext does
        const mockResult = { cancelled: false };
        runtime.newSession = async () => mockResult;
        runtime.switchSession = async () => mockResult;

        const newResult = await runtime.newSession();
        const switchResult = await runtime.switchSession("/test");

        expect(newResult).toEqual(mockResult);
        expect(switchResult).toEqual(mockResult);
    });
});

// ---------------------------------------------------------------------------
// 3. API surface — verify existing (non-patched) APIs still work
// ---------------------------------------------------------------------------

describe("pi-coding-agent API surface compatibility", () => {
    test("createAgentSession is exported", async () => {
        const mod = await import("@mariozechner/pi-coding-agent");
        expect(typeof mod.createAgentSession).toBe("function");
    });

    test("ExtensionRunner class is exported and constructable", async () => {
        const { ExtensionRunner } = await import(
            piCodingAgentPath("dist/core/extensions/runner.js")
        );
        expect(typeof ExtensionRunner).toBe("function");
    });

    test("SessionManager and related types are accessible", async () => {
        const mod = await import("@mariozechner/pi-coding-agent");
        expect(mod.SessionManager).toBeDefined();
        expect(typeof mod.SessionManager).toBe("function");
    });

    test("AuthStorage is exported", async () => {
        const mod = await import("@mariozechner/pi-coding-agent");
        expect(mod.AuthStorage).toBeDefined();
    });

    test("buildSessionContext is exported", async () => {
        const mod = await import("@mariozechner/pi-coding-agent");
        expect(typeof mod.buildSessionContext).toBe("function");
    });
});

// ===========================================================================
// pi-ai patches (Anthropic web search support)
// ===========================================================================

describe("pi-ai patch application — Anthropic web search", () => {
    test("anthropic.js: convertTools passes through server-side tool objects", async () => {
        const source = await Bun.file(
            piAiPath("dist/providers/anthropic.js"),
        ).text();

        // The patch checks for tool.type before converting
        expect(source).toContain("PATCH(pizzapi): pass through server-side tools");
        expect(source).toContain('tool.type && typeof tool.type === "string"');
    });

    test("anthropic.js: buildParams injects web search tool from PIZZAPI_WEB_SEARCH env", async () => {
        const source = await Bun.file(
            piAiPath("dist/providers/anthropic.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi): inject Anthropic web search tool");
        expect(source).toContain("PIZZAPI_WEB_SEARCH");
        expect(source).toContain("web_search_20250305");
        expect(source).toContain("PIZZAPI_WEB_SEARCH_MAX_USES");
        expect(source).toContain("PIZZAPI_WEB_SEARCH_ALLOWED_DOMAINS");
        expect(source).toContain("PIZZAPI_WEB_SEARCH_BLOCKED_DOMAINS");
        // P2: env var must be parsed as explicit boolean (reject "0", "false", "no", "off")
        expect(source).toMatch(/\["0",\s*"false",\s*"no",\s*"off"\]/);
    });

    test("anthropic.js: stream handler processes server_tool_use blocks", async () => {
        const source = await Bun.file(
            piAiPath("dist/providers/anthropic.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi): handle server_tool_use");
        expect(source).toContain('"server_tool_use"');
        expect(source).toContain("_serverToolUse");
    });

    test("anthropic.js: stream handler processes web_search_tool_result blocks", async () => {
        const source = await Bun.file(
            piAiPath("dist/providers/anthropic.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi): handle web_search_tool_result");
        expect(source).toContain('"web_search_tool_result"');
        expect(source).toContain("_webSearchResult");
    });

    test("anthropic.js: convertMessages round-trips server tool blocks", async () => {
        const source = await Bun.file(
            piAiPath("dist/providers/anthropic.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi): round-trip server tool use");
        // Verify both server_tool_use and web_search_tool_result are round-tripped
        expect(source).toContain("block._serverToolUse");
        expect(source).toContain("block._webSearchResult");
    });

    test("anthropic.js: file is syntactically valid", async () => {
        // If the patch broke the JS syntax, this import will throw
        const mod = await import(piAiPath("dist/providers/anthropic.js"));
        expect(typeof mod.streamAnthropic).toBe("function");
        expect(typeof mod.streamSimpleAnthropic).toBe("function");
    });
});
