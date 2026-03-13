import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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

function makeConfig(overrides?: {
    denyRead?: string[];
    allowWrite?: string[];
}): ResolvedSandboxConfig {
    return {
        mode: "basic",
        srtConfig: {
            filesystem: {
                denyRead: overrides?.denyRead ?? ["/etc/secrets", "/home/user/.ssh"],
                allowWrite: overrides?.allowWrite ?? ["/tmp"],
                denyWrite: [],
            },
        },
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

    test("works normally when mode is none", async () => {
        await initSandbox({ mode: "none", srtConfig: null });
        const result = await execRead(testFile);
        expect(result.content[0].text).toBe("hello world");
    });

    describe("sandbox active", () => {
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

        test("records violation when path is denied", async () => {
            // Create a file in a path we will deny
            const deniedDir = mkdtempSync(join(tmpdir(), "denied-"));
            const deniedFile = join(deniedDir, "secret.txt");
            writeFileSync(deniedFile, "secret");

            await initSandbox(makeConfig({ denyRead: [deniedDir] }));
            const result = await execRead(deniedFile);
            expect(result.content[0].text).toContain("❌ Sandbox blocked read");
            expect(getViolations().length).toBe(1);
            expect(getViolations()[0].operation).toBe("read");
        });
    });

    test("has correct tool metadata", () => {
        expect(readFileTool.name).toBe("read_file");
        expect(readFileTool.label).toBe("Read File");
    });
});
