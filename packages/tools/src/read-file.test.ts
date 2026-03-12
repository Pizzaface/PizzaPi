import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileTool } from "./read-file.js";
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
            denyRead: ["/etc/secrets", "/home/user/.ssh"],
            allowWrite: ["/tmp"],
            denyWrite: [],
        },
        sockets: { deny: [] },
        mcp: { allowedDomains: [], allowWrite: ["/tmp"] },
        ...overrides,
    };
}

async function execRead(path: string) {
    return readFileTool.execute("test", { path });
}

describe("readFileTool", () => {
    let tmpDir: string;
    let testFile: string;

    beforeEach(() => {
        _resetState();
        tmpDir = mkdtempSync(join(tmpdir(), "read-test-"));
        testFile = join(tmpDir, "test.txt");
        writeFileSync(testFile, "hello world");
    });

    afterEach(async () => {
        await cleanupSandbox();
    });

    test("reads file content", async () => {
        const result = await execRead(testFile);
        expect(result.content[0].text).toBe("hello world");
        expect(result.details.size).toBe(11);
    });

    test("works normally when sandbox is off", async () => {
        await initSandbox(makeConfig({ mode: "off" }));
        const result = await execRead(testFile);
        expect(result.content[0].text).toBe("hello world");
    });

    test("works normally when sandbox is disabled", async () => {
        await initSandbox(makeConfig({ enabled: false }));
        const result = await execRead(testFile);
        expect(result.content[0].text).toBe("hello world");
    });

    describe("enforce mode", () => {
        test("blocks reads to denied paths", async () => {
            await initSandbox(makeConfig());
            const result = await execRead("/etc/secrets/key.pem");
            expect(result.content[0].text).toContain("❌ Sandbox blocked read");
            expect(result.details.sandboxBlocked).toBe(true);
        });

        test("blocks reads to children of denied paths", async () => {
            await initSandbox(makeConfig());
            const result = await execRead("/home/user/.ssh/id_rsa");
            expect(result.content[0].text).toContain("❌ Sandbox blocked read");
        });

        test("allows reads to non-denied paths", async () => {
            await initSandbox(makeConfig());
            const result = await execRead(testFile);
            expect(result.content[0].text).toBe("hello world");
        });
    });

    describe("audit mode", () => {
        test("allows reads to denied paths but records violation", async () => {
            // Create a file in a "denied" path for the test
            const deniedDir = mkdtempSync(join(tmpdir(), "denied-"));
            const deniedFile = join(deniedDir, "secret.txt");
            writeFileSync(deniedFile, "secret data");

            await initSandbox(makeConfig({
                mode: "audit",
                filesystem: { denyRead: [deniedDir], allowWrite: ["/tmp"], denyWrite: [] },
            }));

            const result = await execRead(deniedFile);
            expect(result.content[0].text).toBe("secret data"); // allowed in audit
            expect(getViolations().length).toBe(1);
            expect(getViolations()[0].operation).toBe("read");
        });

        test("logs audit warning to console", async () => {
            const deniedDir = mkdtempSync(join(tmpdir(), "denied-"));
            const deniedFile = join(deniedDir, "secret.txt");
            writeFileSync(deniedFile, "data");

            const spy = spyOn(console, "log").mockImplementation(() => {});
            try {
                await initSandbox(makeConfig({
                    mode: "audit",
                    filesystem: { denyRead: [deniedDir], allowWrite: ["/tmp"], denyWrite: [] },
                }));
                await execRead(deniedFile);

                const auditCalls = spy.mock.calls.filter(
                    (c) => typeof c[0] === "string" && c[0].includes("[sandbox:audit]"),
                );
                expect(auditCalls.length).toBe(1);
                expect(auditCalls[0][0]).toContain("Would block read");
            } finally {
                spy.mockRestore();
            }
        });
    });

    test("has correct tool metadata", () => {
        expect(readFileTool.name).toBe("read_file");
        expect(readFileTool.label).toBe("Read File");
    });
});
