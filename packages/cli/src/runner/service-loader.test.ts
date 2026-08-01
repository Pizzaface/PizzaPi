import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServiceModule } from "./service-loader.js";

/**
 * Only module coercion lives here now. Discovery moved entirely to
 * package-service-loader.ts when the legacy directory/plugin scanners were
 * removed — see package-service-loader.test.ts for that side.
 */
describe("loadServiceModule", () => {
    let dir: string;
    let n = 0;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pizzapi-service-module-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    /** Unique filename per call — ESM import caching would otherwise reuse the first module. */
    function writeModule(source: string): string {
        const file = join(dir, `svc-${n++}.mjs`);
        writeFileSync(file, source, "utf-8");
        return file;
    }

    const HANDLER_BODY = `{ id: "demo", init() {}, dispose() {} }`;

    test("accepts a default-exported instance", async () => {
        const handler = await loadServiceModule(writeModule(`export default ${HANDLER_BODY};`));
        expect(handler?.id).toBe("demo");
    });

    test("constructs a default-exported class", async () => {
        const handler = await loadServiceModule(writeModule(`
            export default class { get id() { return "demo"; } init() {} dispose() {} };
        `));
        expect(handler?.id).toBe("demo");
    });

    test("calls a default-exported factory function", async () => {
        const handler = await loadServiceModule(writeModule(`export default () => (${HANDLER_BODY});`));
        expect(handler?.id).toBe("demo");
    });

    test("awaits an async factory", async () => {
        const handler = await loadServiceModule(writeModule(`export default async () => (${HANDLER_BODY});`));
        expect(handler?.id).toBe("demo");
    });

    test("falls back to module exports when there is no default", async () => {
        const handler = await loadServiceModule(writeModule(`
            export const id = "demo";
            export function init() {}
            export function dispose() {}
        `));
        expect(handler?.id).toBe("demo");
    });

    test("returns null when the shape is not a ServiceHandler", async () => {
        expect(await loadServiceModule(writeModule(`export default { nope: true };`))).toBeNull();
    });

    test("returns null when required methods are missing", async () => {
        expect(await loadServiceModule(writeModule(`export default { id: "demo", init() {} };`))).toBeNull();
    });

    test("returns null when id is not a string", async () => {
        expect(await loadServiceModule(writeModule(`export default { id: 42, init() {}, dispose() {} };`))).toBeNull();
    });

    // A constructor that throws must not abort the load — it falls through to
    // the factory branch, and only returns null if that fails too.
    test("returns null when a throwing constructor is also not a valid factory", async () => {
        expect(await loadServiceModule(writeModule(`
            export default function () { throw new Error("boom"); };
        `))).toBeNull();
    });

    test("propagates an import-time failure rather than swallowing it", async () => {
        expect(loadServiceModule(writeModule(`throw new Error("module blew up");`)))
            .rejects.toThrow("module blew up");
    });
});
