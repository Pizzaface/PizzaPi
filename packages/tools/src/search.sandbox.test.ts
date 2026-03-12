import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { which } from "bun";
import { searchTool } from "./search.js";
import {
    initSandbox,
    cleanupSandbox,
    getViolations,
    _resetState,
    type ResolvedSandboxConfig,
} from "./sandbox.js";

/** Whether `rg` (ripgrep) is available — content search tests require it. */
const hasRg = !!which("rg");

function makeConfig(overrides?: Partial<ResolvedSandboxConfig>): ResolvedSandboxConfig {
    return {
        enabled: true,
        mode: "enforce",
        network: { mode: "denylist", allowedDomains: [], deniedDomains: [] },
        filesystem: {
            denyRead: [],
            allowWrite: ["/tmp"],
            denyWrite: [],
        },
        sockets: { deny: [] },
        mcp: { allowedDomains: [], allowWrite: ["/tmp"] },
        ...overrides,
    };
}

async function execSearch(pattern: string, path: string, type?: string) {
    return searchTool.execute("test", { pattern, path, type });
}

describe("searchTool sandbox integration", () => {
    let tmpDir: string;

    beforeEach(() => {
        _resetState();
        tmpDir = mkdtempSync(join(tmpdir(), "search-test-"));
        // Create some test files
        writeFileSync(join(tmpDir, "hello.txt"), "hello world");
        writeFileSync(join(tmpDir, "secret.txt"), "password=abc123");
        mkdirSync(join(tmpDir, "sub"));
        writeFileSync(join(tmpDir, "sub", "nested.txt"), "nested content");
    });

    afterEach(async () => {
        await cleanupSandbox();
    });

    test.skipIf(!hasRg)("searches normally when sandbox is off", async () => {
        await initSandbox(makeConfig({ mode: "off" }));
        const result = await execSearch("hello", tmpDir, "content");
        expect(result.content[0].text).toContain("hello");
    });

    test.skipIf(!hasRg)("searches normally when sandbox is disabled", async () => {
        await initSandbox(makeConfig({ enabled: false }));
        const result = await execSearch("hello", tmpDir, "content");
        expect(result.content[0].text).toContain("hello");
    });

    describe("enforce mode", () => {
        test("blocks search in denied read paths", async () => {
            await initSandbox(makeConfig({
                filesystem: { denyRead: [tmpDir], allowWrite: ["/tmp"], denyWrite: [] },
            }));
            const result = await execSearch("password", tmpDir, "content");
            expect(result.content[0].text).toContain("❌ Sandbox blocked search");
            expect(result.details.sandboxBlocked).toBe(true);
        });

        test("blocks file search in denied paths", async () => {
            await initSandbox(makeConfig({
                filesystem: { denyRead: [tmpDir], allowWrite: ["/tmp"], denyWrite: [] },
            }));
            const result = await execSearch("*.txt", tmpDir, "files");
            expect(result.content[0].text).toContain("❌ Sandbox blocked search");
        });

        test.skipIf(!hasRg)("allows search in non-denied paths", async () => {
            await initSandbox(makeConfig({
                filesystem: { denyRead: ["/home/user/.ssh"], allowWrite: ["/tmp"], denyWrite: [] },
            }));
            const result = await execSearch("hello", tmpDir, "content");
            expect(result.content[0].text).toContain("hello");
        });
    });

    describe("audit mode", () => {
        test.skipIf(!hasRg)("allows search in denied paths but records violation", async () => {
            await initSandbox(makeConfig({
                mode: "audit",
                filesystem: { denyRead: [tmpDir], allowWrite: ["/tmp"], denyWrite: [] },
            }));
            const result = await execSearch("hello", tmpDir, "content");
            // Should still return results (audit mode doesn't block)
            expect(result.content[0].text).toContain("hello");
            expect(getViolations().length).toBe(1);
            expect(getViolations()[0].operation).toBe("read");
        });

        test.skipIf(!hasRg)("logs audit warning to console", async () => {
            const spy = spyOn(console, "log").mockImplementation(() => {});
            try {
                await initSandbox(makeConfig({
                    mode: "audit",
                    filesystem: { denyRead: [tmpDir], allowWrite: ["/tmp"], denyWrite: [] },
                }));
                await execSearch("hello", tmpDir, "content");

                const auditCalls = spy.mock.calls.filter(
                    (c) => typeof c[0] === "string" && c[0].includes("[sandbox:audit]"),
                );
                expect(auditCalls.length).toBe(1);
                expect(auditCalls[0][0]).toContain("Would block search");
            } finally {
                spy.mockRestore();
            }
        });
    });
});
