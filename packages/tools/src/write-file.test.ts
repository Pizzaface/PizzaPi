import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync as writeFileSyncFs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    initSandbox,
    cleanupSandbox,
    _resetState,
    type ResolvedSandboxConfig,
} from "./sandbox.js";

// ── fs/promises mock ──────────────────────────────────────────────────────────
// node:fs/promises and fs/promises are the same Bun module registry entry, so
// using the named import as the default impl creates infinite recursion.
// Instead we use sync fs variants (from the "fs" module, which is not mocked)
// as the real-I/O implementation for smoke / permitted-path tests.
//
// Include readFile stub so this mock doesn't break read-file.test.ts when both
// files share a Bun process and this mock.module() call runs first.
const mockMkdir = mock(async (path: string, opts?: unknown): Promise<string | undefined> => {
    mkdirSync(String(path), opts as Parameters<typeof mkdirSync>[1]);
    return undefined;
});
const mockWriteFile = mock(async (path: string, data: string, enc?: unknown): Promise<void> => {
    writeFileSyncFs(String(path), data, (enc as BufferEncoding) ?? "utf-8");
});
const _readFileStub = mock(async (_path: string, _enc?: unknown): Promise<string> => "");
mock.module("fs/promises", () => ({
    readFile: _readFileStub,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
}));

// ── SUT — dynamically imported so it binds the mocked fs/promises ─────────────
const { writeFileTool } = await import("./write-file.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides?: {
    allowWrite?: string[];
    denyWrite?: string[];
}): ResolvedSandboxConfig {
    return {
        mode: "basic",
        srtConfig: {
            filesystem: {
                denyRead: [],
                allowWrite: overrides?.allowWrite ?? ["/tmp"],
                denyWrite: overrides?.denyWrite ?? [],
            },
        },
    };
}

function makeErrno(code: string, message = code): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code });
}

async function execWrite(path: string, content: string) {
    return writeFileTool.execute("test", { path, content });
}

describe("writeFileTool", () => {
    let tmpDir: string;

    beforeEach(() => {
        _resetState();
        mockWriteFile.mockClear();
        mockMkdir.mockClear();
        // Restore to sync-fs pass-throughs between tests (avoids circular mock via node:fs/promises)
        mockMkdir.mockImplementation(async (path: string, opts?: unknown): Promise<string | undefined> => {
            mkdirSync(String(path), opts as Parameters<typeof mkdirSync>[1]);
            return undefined;
        });
        mockWriteFile.mockImplementation(async (path: string, data: string, enc?: unknown): Promise<void> => {
            writeFileSyncFs(String(path), data, (enc as BufferEncoding) ?? "utf-8");
        });
        tmpDir = mkdtempSync(join(tmpdir(), "write-test-"));
    });

    afterEach(async () => {
        await cleanupSandbox();
    });

    // ── Smoke: verifies the real I/O path end-to-end (mkdir + writeFile) ──────
    test("smoke: writes file and creates parent directories", async () => {
        const filePath = join(tmpDir, "sub", "dir", "out.txt");
        const result = await execWrite(filePath, "nested content");
        expect(result.content[0].text).toContain("Wrote 14 bytes");
        expect(readFileSync(filePath, "utf-8")).toBe("nested content");
    });

    // ── Unit: errno → message mapping (no real I/O) ───────────────────────────
    describe("errno → message mapping", () => {
        test("EACCES → 'Permission denied'", async () => {
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockRejectedValue(makeErrno("EACCES"));
            const result = await execWrite("/etc/shadow", "x");
            expect(result.content[0].text).toContain("Permission denied");
            expect(result.details.error).toBe("EACCES");
            expect(result.details.size).toBe(0);
        });

        test("ENOSPC → 'No space left on device'", async () => {
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockRejectedValue(makeErrno("ENOSPC"));
            const result = await execWrite("/tmp/full.txt", "x");
            expect(result.content[0].text).toContain("No space left on device");
            expect(result.details.error).toBe("ENOSPC");
        });

        test("EISDIR → 'Path is a directory, not a file'", async () => {
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockRejectedValue(makeErrno("EISDIR"));
            const result = await execWrite("/some/dir", "x");
            expect(result.content[0].text).toContain("Path is a directory");
            expect(result.details.error).toBe("EISDIR");
        });

        test("ENOENT from mkdir → 'Parent directory could not be created'", async () => {
            mockMkdir.mockRejectedValue(makeErrno("ENOENT"));
            const result = await execWrite("/deep/missing/path.txt", "x");
            expect(result.content[0].text).toContain("Parent directory could not be created");
            expect(result.details.error).toBe("ENOENT");
        });

        test("unknown code → generic message with original error text", async () => {
            mockMkdir.mockResolvedValue(undefined);
            mockWriteFile.mockRejectedValue(makeErrno("EDQUOT", "disk quota exceeded"));
            const result = await execWrite("/tmp/out.txt", "x");
            expect(result.content[0].text).toContain("❌");
            expect(result.content[0].text).toContain("disk quota exceeded");
            expect(result.details.error).toBe("EDQUOT");
        });
    });

    // ── Unit: sandbox path validation (no I/O needed) ─────────────────────────
    describe("sandbox", () => {
        test("blocks writes outside allowWrite — no I/O performed", async () => {
            await initSandbox(makeConfig({ allowWrite: ["/tmp/allowed-only"] }));
            const filePath = join(tmpDir, "blocked.txt");
            const result = await execWrite(filePath, "should fail");
            expect(result.content[0].text).toContain("❌ Sandbox blocked write");
            expect(result.content[0].text).toContain("allowWrite");
            expect(result.details.sandboxBlocked).toBe(true);
            expect(mockWriteFile.mock.calls.length).toBe(0); // sandbox short-circuits before I/O
            expect(existsSync(filePath)).toBe(false);
        });

        test("blocks writes to denyWrite paths — no I/O performed", async () => {
            await initSandbox(makeConfig({ allowWrite: ["/tmp"], denyWrite: ["/tmp/.env"] }));
            const result = await execWrite("/tmp/.env", "secret=123");
            expect(result.content[0].text).toContain("❌ Sandbox blocked write");
            expect(result.details.sandboxBlocked).toBe(true);
            expect(mockWriteFile.mock.calls.length).toBe(0);
        });

        test("allows writes to permitted paths", async () => {
            await initSandbox(makeConfig({ allowWrite: [tmpDir], denyWrite: [] }));
            const filePath = join(tmpDir, "allowed.txt");
            const result = await execWrite(filePath, "allowed");
            expect(result.content[0].text).toContain("Wrote 7 bytes");
            expect(readFileSync(filePath, "utf-8")).toBe("allowed");
        });

        test("mode=none: no sandbox restrictions apply", async () => {
            await initSandbox({ mode: "none", srtConfig: null });
            const filePath = join(tmpDir, "off.txt");
            const result = await execWrite(filePath, "off mode");
            expect(result.content[0].text).toContain("Wrote 8 bytes");
            expect(readFileSync(filePath, "utf-8")).toBe("off mode");
        });
    });

    // ── Metadata ──────────────────────────────────────────────────────────────
    test("tool metadata", () => {
        expect(writeFileTool.name).toBe("write_file");
        expect(writeFileTool.label).toBe("Write File");
    });

});
