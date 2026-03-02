/**
 * Patch compatibility tests for @mariozechner/pi-coding-agent.
 *
 * These tests verify that the bun patches applied to pi-coding-agent
 * are correctly in place and the patched APIs function as expected.
 *
 * If these tests fail after a pi-coding-agent version bump, you need to
 * recreate the patch. See patches/README.md for details.
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

    test("agent-session.js: abort() calls clearQueue()", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/core/agent-session.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi)");
        // The abort method should call clearQueue to prevent message duplication
        const abortStart = source.indexOf("async abort()");
        expect(abortStart).not.toBe(-1);
        const abortBody = source.slice(abortStart, abortStart + 500);
        expect(abortBody).toContain("this.clearQueue()");
    });

    test("auth-storage.js: withLock() has ELOCKED fallback", async () => {
        const source = await Bun.file(
            piCodingAgentPath("dist/core/auth-storage.js"),
        ).text();

        expect(source).toContain("PATCH(pizzapi)");
        expect(source).toContain("ELOCKED");
        // The fallback should be in withLock, not reload
        const withLockStart = source.indexOf("withLock(fn) {");
        const withLockEnd = source.indexOf("async withLockAsync");
        const withLockBody = source.slice(withLockStart, withLockEnd);
        expect(withLockBody).toContain("ELOCKED");
    });
});

// ---------------------------------------------------------------------------
// 2a. Functional — verify auth-storage ELOCKED fallback works
// ---------------------------------------------------------------------------

describe("pi-coding-agent auth-storage ELOCKED fallback", () => {
    test("reload() succeeds when lock is held by another process", async () => {
        const { AuthStorage, FileAuthStorageBackend } = await import(
            piCodingAgentPath("dist/core/auth-storage.js")
        );
        const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { tmpdir } = await import("node:os");

        // Create a temp auth.json with test credentials
        const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-test-"));
        const authPath = join(tmpDir, "auth.json");
        const testData = { "test-provider": { type: "api_key", key: "sk-test-123" } };
        writeFileSync(authPath, JSON.stringify(testData), "utf-8");

        // Simulate a held lock by creating the .lock directory
        mkdirSync(authPath + ".lock");

        // Create an AuthStorage backed by the locked file.
        // Without the patch this would leave data empty;
        // with the patch the ELOCKED fallback reads without locking.
        const storage = AuthStorage.create(authPath);
        const cred = storage.get("test-provider");

        expect(cred).toBeDefined();
        expect(cred?.type).toBe("api_key");
        expect(cred?.key).toBe("sk-test-123");

        // Clean up
        const { rmSync } = await import("node:fs");
        rmSync(tmpDir, { recursive: true, force: true });
    });
});

// ---------------------------------------------------------------------------
// 2b. Functional — verify patched runtime/API objects behave correctly
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
