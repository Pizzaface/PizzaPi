import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMobileOtaRoute } from "../src/routes/mobile-ota.js";

function get(path: string): Promise<Response | undefined> {
    const url = new URL(`http://localhost${path}`);
    return handleMobileOtaRoute(new Request(url, { method: "GET" }), url);
}

describe("handleMobileOtaRoute", () => {
    let dir: string;
    const prev = process.env.PIZZAPI_MOBILE_OTA_DIR;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pp-ota-"));
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "t", checksum: "abc" }));
        writeFileSync(join(dir, "pizzapi-t.zip"), "PK\u0003\u0004fake-zip");
        process.env.PIZZAPI_MOBILE_OTA_DIR = dir;
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        if (prev === undefined) delete process.env.PIZZAPI_MOBILE_OTA_DIR;
        else process.env.PIZZAPI_MOBILE_OTA_DIR = prev;
    });

    it("ignores non-OTA paths", async () => {
        expect(await get("/api/health")).toBeUndefined();
    });

    it("serves the manifest with no-cache", async () => {
        const res = await get("/api/mobile/ota/manifest.json");
        expect(res?.status).toBe(200);
        expect(res?.headers.get("content-type")).toContain("application/json");
        expect(res?.headers.get("cache-control")).toContain("no-cache");
        expect(await res?.json()).toEqual({ version: "t", checksum: "abc" });
    });

    it("serves a bundle zip immutably", async () => {
        const res = await get("/api/mobile/ota/pizzapi-t.zip");
        expect(res?.status).toBe(200);
        expect(res?.headers.get("content-type")).toBe("application/zip");
        expect(res?.headers.get("cache-control")).toContain("immutable");
    });

    it("404s unknown bundles and non-zip names", async () => {
        expect((await get("/api/mobile/ota/missing.zip"))?.status).toBe(404);
        expect((await get("/api/mobile/ota/evil.sh"))?.status).toBe(404);
    });

    it("blocks path traversal", async () => {
        expect((await get("/api/mobile/ota/..%2f..%2fetc%2fpasswd"))?.status).toBe(404);
    });

    it("404s the whole feature when unconfigured", async () => {
        delete process.env.PIZZAPI_MOBILE_OTA_DIR;
        expect((await get("/api/mobile/ota/manifest.json"))?.status).toBe(404);
    });
});
