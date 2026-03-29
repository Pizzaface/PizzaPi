import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    initSandbox,
    cleanupSandbox,
    getViolations,
    _resetState,
    type ResolvedSandboxConfig,
} from "./sandbox.js";

// ── fs/promises mock ──────────────────────────────────────────────────────────
// node:fs/promises and fs/promises resolve to the same Bun module registry
// entry, so we cannot use the named import as the default impl (infinite loop).
// Instead we default to Bun.file().text() which is a completely separate API.
//
// Include writeFile/mkdir stubs so this mock doesn't break write-file.test.ts
// when both files share a Bun process and this mock.module() call runs first.
const mockReadFile = mock(async (path: string, _enc?: unknown): Promise<string> =>
    Bun.file(String(path)).text()
);
const _writeFileStub = mock(async (): Promise<void> => {});
const _mkdirStub = mock(async (): Promise<string | undefined> => undefined);
mock.module("fs/promises", () => ({
    readFile: mockReadFile,
    writeFile: _writeFileStub,
    mkdir: _mkdirStub,
}));

// ── SUT — dynamically imported so it binds the mocked fs/promises ─────────────
const { readFileTool } = await import("./read-file.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides?: { denyRead?: string[] }): ResolvedSandboxConfig {
    return {
        mode: "basic",
        srtConfig: {
            filesystem: {
                denyRead: overrides?.denyRead ?? ["/etc/secrets"],
                allowWrite: ["/tmp"],
                denyWrite: [],
            },
        },
    };
}

function makeErrno(code: string, message = code): NodeJS.ErrnoException {
    return Object.assign(new Error(message), { code });
}

async function execRead(path: string) {
    return readFileTool.execute("test", { path });
}

describe("readFileTool", () => {
    beforeEach(() => {
        _resetState();
        mockReadFile.mockClear();
        // Restore to the Bun.file() pass-through between tests
        mockReadFile.mockImplementation(async (path: string, _enc?: unknown): Promise<string> =>
            Bun.file(String(path)).text()
        );
    });

    afterEach(async () => {
        await cleanupSandbox();
    });

    // ── Smoke: verifies the real I/O path end-to-end ──────────────────────────
    test("smoke: reads an actual file from disk", async () => {
        const dir = mkdtempSync(join(tmpdir(), "read-smoke-"));
        const file = join(dir, "smoke.txt");
        writeFileSync(file, "hello world");
        const result = await execRead(file);
        expect(result.content[0].text).toBe("hello world");
        expect(result.details.size).toBe(11);
    });

    // ── Unit: errno → message mapping (no real I/O) ───────────────────────────
    describe("errno → message mapping", () => {
        test("ENOENT → 'File not found'", async () => {
            mockReadFile.mockRejectedValue(makeErrno("ENOENT"));
            const result = await execRead("/nonexistent/file.txt");
            expect(result.content[0].text).toContain("❌");
            expect(result.content[0].text).toContain("File not found");
            expect(result.details.error).toBe("ENOENT");
            expect(result.details.size).toBe(0);
        });

        test("EACCES → 'Permission denied'", async () => {
            mockReadFile.mockRejectedValue(makeErrno("EACCES"));
            const result = await execRead("/root/private.txt");
            expect(result.content[0].text).toContain("Permission denied");
            expect(result.details.error).toBe("EACCES");
            expect(result.details.size).toBe(0);
        });

        test("EISDIR → 'Path is a directory, not a file'", async () => {
            mockReadFile.mockRejectedValue(makeErrno("EISDIR"));
            const result = await execRead("/some/dir");
            expect(result.content[0].text).toContain("Path is a directory");
            expect(result.details.error).toBe("EISDIR");
        });

        test("unknown code → generic message with original error text", async () => {
            mockReadFile.mockRejectedValue(makeErrno("EMFILE", "too many open files"));
            const result = await execRead("/some/file.txt");
            expect(result.content[0].text).toContain("❌");
            expect(result.content[0].text).toContain("too many open files");
            expect(result.details.error).toBe("EMFILE");
        });
    });

    // ── Unit: sandbox path validation (no I/O needed) ─────────────────────────
    describe("sandbox", () => {
        test("blocks reads to denied paths — no I/O performed", async () => {
            await initSandbox(makeConfig({ denyRead: ["/etc/secrets"] }));
            const result = await execRead("/etc/secrets/key.pem");
            expect(result.content[0].text).toContain("❌ Sandbox blocked read");
            expect(result.details.sandboxBlocked).toBe(true);
            expect(mockReadFile.mock.calls.length).toBe(0); // sandbox short-circuits before I/O
        });

        test("blocks children of denied paths — no I/O performed", async () => {
            await initSandbox(makeConfig({ denyRead: ["/home/user/.ssh"] }));
            const result = await execRead("/home/user/.ssh/id_rsa");
            expect(result.content[0].text).toContain("❌ Sandbox blocked read");
            expect(mockReadFile.mock.calls.length).toBe(0);
        });

        test("records violation when path is denied", async () => {
            await initSandbox(makeConfig({ denyRead: ["/secret"] }));
            await execRead("/secret/token");
            const violations = getViolations();
            expect(violations.length).toBe(1);
            expect(violations[0].operation).toBe("read");
        });

        test("allows reads to non-denied paths", async () => {
            await initSandbox(makeConfig());
            mockReadFile.mockResolvedValue("safe content");
            const result = await execRead("/tmp/safe.txt");
            expect(result.content[0].text).toBe("safe content");
        });

        test("mode=none: no sandbox restrictions apply", async () => {
            await initSandbox({ mode: "none", srtConfig: null });
            mockReadFile.mockResolvedValue("unrestricted");
            const result = await execRead("/etc/secrets/key.pem");
            expect(result.content[0].text).toBe("unrestricted");
        });
    });

    // ── Metadata ──────────────────────────────────────────────────────────────
    test("tool metadata", () => {
        expect(readFileTool.name).toBe("read_file");
        expect(readFileTool.label).toBe("Read File");
    });
});
