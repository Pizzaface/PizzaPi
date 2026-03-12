import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileTool } from "./write-file.js";
import {
    initSandbox,
    cleanupSandbox,
    getViolations,
    _resetState,
    type ResolvedSandboxConfig,
} from "./sandbox.js";

function makeConfig(overrides?: Partial<ResolvedSandboxConfig>): ResolvedSandboxConfig {
    return {
        enabled: true,
        mode: "enforce",
        network: { mode: "denylist", allowedDomains: [], deniedDomains: [] },
        filesystem: {
            denyRead: [],
            allowWrite: ["/tmp"],
            denyWrite: ["/tmp/.env"],
        },
        sockets: { deny: [] },
        mcp: { allowedDomains: [], allowWrite: ["/tmp"] },
        ...overrides,
    };
}

async function execWrite(path: string, content: string) {
    return writeFileTool.execute("test", { path, content });
}

describe("writeFileTool", () => {
    let tmpDir: string;

    beforeEach(() => {
        _resetState();
        tmpDir = mkdtempSync(join(tmpdir(), "write-test-"));
    });

    afterEach(async () => {
        await cleanupSandbox();
    });

    test("writes file content", async () => {
        const filePath = join(tmpDir, "out.txt");
        const result = await execWrite(filePath, "hello");
        expect(result.content[0].text).toContain("Wrote 5 bytes");
        expect(readFileSync(filePath, "utf-8")).toBe("hello");
    });

    test("creates directories as needed", async () => {
        const filePath = join(tmpDir, "sub", "dir", "out.txt");
        await execWrite(filePath, "nested");
        expect(readFileSync(filePath, "utf-8")).toBe("nested");
    });

    test("works normally when sandbox is off", async () => {
        await initSandbox(makeConfig({ mode: "off" }));
        const filePath = join(tmpDir, "off.txt");
        await execWrite(filePath, "off mode");
        expect(readFileSync(filePath, "utf-8")).toBe("off mode");
    });

    describe("enforce mode", () => {
        test("blocks writes outside allowWrite paths", async () => {
            await initSandbox(makeConfig({
                filesystem: { denyRead: [], allowWrite: ["/tmp/allowed-only"], denyWrite: [] },
            }));
            const filePath = join(tmpDir, "blocked.txt");
            const result = await execWrite(filePath, "should fail");
            expect(result.content[0].text).toContain("❌ Sandbox blocked write");
            expect(result.content[0].text).toContain("allowWrite");
            expect(result.details.sandboxBlocked).toBe(true);
            expect(existsSync(filePath)).toBe(false);
        });

        test("blocks writes to denyWrite paths", async () => {
            await initSandbox(makeConfig());
            const result = await execWrite("/tmp/.env", "secret=123");
            expect(result.content[0].text).toContain("❌ Sandbox blocked write");
            expect(result.details.sandboxBlocked).toBe(true);
        });

        test("allows writes to permitted paths", async () => {
            await initSandbox(makeConfig({
                filesystem: { denyRead: [], allowWrite: [tmpDir], denyWrite: [] },
            }));
            const filePath = join(tmpDir, "allowed.txt");
            const result = await execWrite(filePath, "allowed");
            expect(result.content[0].text).toContain("Wrote 7 bytes");
            expect(readFileSync(filePath, "utf-8")).toBe("allowed");
        });
    });

    describe("audit mode", () => {
        test("allows writes but records violation", async () => {
            await initSandbox(makeConfig({
                mode: "audit",
                filesystem: { denyRead: [], allowWrite: ["/tmp/nowhere"], denyWrite: [] },
            }));
            const filePath = join(tmpDir, "audit.txt");
            const result = await execWrite(filePath, "audit data");
            expect(result.content[0].text).toContain("Wrote 10 bytes"); // allowed
            expect(readFileSync(filePath, "utf-8")).toBe("audit data");
            expect(getViolations().length).toBe(1);
            expect(getViolations()[0].operation).toBe("write");
        });

        test("logs audit warning to console", async () => {
            const spy = spyOn(console, "log").mockImplementation(() => {});
            try {
                await initSandbox(makeConfig({
                    mode: "audit",
                    filesystem: { denyRead: [], allowWrite: ["/tmp/nowhere"], denyWrite: [] },
                }));
                const filePath = join(tmpDir, "audit-warn.txt");
                await execWrite(filePath, "data");

                const auditCalls = spy.mock.calls.filter(
                    (c) => typeof c[0] === "string" && c[0].includes("[sandbox:audit]"),
                );
                expect(auditCalls.length).toBe(1);
                expect(auditCalls[0][0]).toContain("Would block write");
            } finally {
                spy.mockRestore();
            }
        });
    });

    test("has correct tool metadata", () => {
        expect(writeFileTool.name).toBe("write_file");
        expect(writeFileTool.label).toBe("Write File");
    });
});
