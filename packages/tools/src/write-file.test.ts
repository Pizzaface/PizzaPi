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

function makeConfig(overrides?: {
    allowWrite?: string[];
    denyWrite?: string[];
    denyRead?: string[];
}): ResolvedSandboxConfig {
    return {
        mode: "basic",
        srtConfig: {
            filesystem: {
                denyRead: overrides?.denyRead ?? [],
                allowWrite: overrides?.allowWrite ?? ["/tmp"],
                denyWrite: overrides?.denyWrite ?? ["/tmp/.env"],
            },
        },
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

    test("works normally when mode is none", async () => {
        await initSandbox({ mode: "none", srtConfig: null });
        const filePath = join(tmpDir, "off.txt");
        await execWrite(filePath, "off mode");
        expect(readFileSync(filePath, "utf-8")).toBe("off mode");
    });

    describe("sandbox active (basic/full mode)", () => {
        test("blocks writes outside allowWrite paths", async () => {
            await initSandbox(makeConfig({ allowWrite: ["/tmp/allowed-only"] }));
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
            await initSandbox(makeConfig({ allowWrite: [tmpDir], denyWrite: [] }));
            const filePath = join(tmpDir, "allowed.txt");
            const result = await execWrite(filePath, "allowed");
            expect(result.content[0].text).toContain("Wrote 7 bytes");
            expect(readFileSync(filePath, "utf-8")).toBe("allowed");
        });
    });

    test("has correct tool metadata", () => {
        expect(writeFileTool.name).toBe("write_file");
        expect(writeFileTool.label).toBe("Write File");
    });
});
