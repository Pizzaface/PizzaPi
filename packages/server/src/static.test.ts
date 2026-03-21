import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { serveStaticFile, setUiDir } from "./static.js";
import { join } from "path";

describe("serveStaticFile", () => {
    const mockUiDir = join(process.cwd(), "tests/fixtures/ui");

    beforeAll(() => {
        setUiDir(mockUiDir);
    });

    afterAll(() => {
        setUiDir(null);
    });

    test("Rejects malformed URI components", async () => {
        const res = await serveStaticFile("/%c0%af");
        expect(res).toBeNull();
    });

    test("Rejects null bytes", async () => {
        const res = await serveStaticFile("/file%00.txt");
        expect(res).toBeNull();
    });

    test("Rejects path traversal outside UI_DIR", async () => {
        const res = await serveStaticFile("/../../../etc/passwd");
        expect(res).toBeNull();
    });

    test("Rejects URL-encoded path traversal outside UI_DIR", async () => {
        const res = await serveStaticFile("/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd");
        expect(res).toBeNull();
    });
});
