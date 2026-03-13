import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { which } from "bun";
import { searchTool } from "./search.js";
import {
    initSandbox,
    cleanupSandbox,
    _resetState,
    type ResolvedSandboxConfig,
} from "./sandbox.js";

/** Whether `rg` (ripgrep) is available — content search tests require it. */
const hasRg = !!which("rg");

function makeConfig(overrides?: {
    denyRead?: string[];
    allowWrite?: string[];
}): ResolvedSandboxConfig {
    return {
        mode: "basic",
        srtConfig: {
            filesystem: {
                denyRead: overrides?.denyRead ?? [],
                allowWrite: overrides?.allowWrite ?? ["/tmp"],
                denyWrite: [],
            },
        },
    };
}

async function execSearch(pattern: string, path: string, type?: string) {
    return searchTool.execute("test", { pattern, path, type });
}

describe("searchTool sandbox integration", () => {
    let tmpDir: string;

    beforeEach(() => {
        _resetState();
        tmpDir = mkdtempSync(join(tmpdir(), "search-sandbox-test-"));
    });

    afterEach(async () => {
        await cleanupSandbox();
    });

    test("blocks search in denied directories", async () => {
        await initSandbox(makeConfig({ denyRead: [tmpDir] }));
        const result = await execSearch("*.ts", tmpDir, "files");
        expect(result.content[0].text).toContain("❌ Sandbox blocked search");
        expect(result.details.sandboxBlocked).toBe(true);
    });

    test("allows search in permitted directories", async () => {
        writeFileSync(join(tmpDir, "hello.ts"), "const x = 1;");
        await initSandbox(makeConfig({ denyRead: [] }));
        const result = await execSearch("*.ts", tmpDir, "files");
        expect(result.content[0].text).not.toContain("Sandbox blocked");
    });

    test.skipIf(!hasRg)("blocks content search in denied directory", async () => {
        const deniedDir = mkdtempSync(join(tmpdir(), "denied-"));
        writeFileSync(join(deniedDir, "secret.ts"), "const password = 'hunter2';");
        await initSandbox(makeConfig({ denyRead: [deniedDir] }));
        const result = await execSearch("password", deniedDir);
        expect(result.content[0].text).toContain("❌ Sandbox blocked search");
    });

    test("works normally when mode is none", async () => {
        writeFileSync(join(tmpDir, "test.ts"), "export const x = 1;");
        await initSandbox({ mode: "none", srtConfig: null });
        const result = await execSearch("*.ts", tmpDir, "files");
        expect(result.content[0].text).not.toContain("Sandbox blocked");
    });
});
