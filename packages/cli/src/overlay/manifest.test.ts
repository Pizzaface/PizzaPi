import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOverlayManifest, resolveConfinedPath, OVERLAY_SIDECAR_MAX_BYTES } from "./manifest.js";

const provenance = { identity: "local:/pkg", source: "./pkg", scope: "user" as const };

function fixturePkg(overlay: unknown, extra?: (dir: string) => void): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "pizzapi-overlay-")));
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "fixture", version: "1.0.0", pi: { pizzapi: overlay } }),
    );
    writeFileSync(join(dir, "service.ts"), "export default {};");
    if (extra) extra(dir);
    return dir;
}

describe("readOverlayManifest", () => {
    let dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs) rmSync(d, { recursive: true, force: true });
        dirs = [];
    });

    test("absent pi.pizzapi: overlay null, present false, no issues", () => {
        const dir = mkdtempSync(join(tmpdir(), "pizzapi-overlay-"));
        dirs.push(dir);
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
        const result = readOverlayManifest(dir, { ...provenance, identity: "local:x" });
        expect(result.overlay).toBeNull();
        expect(result.present).toBe(false);
        expect(result.issues).toHaveLength(0);
    });

    test("valid minimal overlay with a service", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "github", label: "GitHub", entry: "./service.ts" }],
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.issues).toHaveLength(0);
        expect(result.overlay?.services?.[0]?.id).toBe("github");
    });

    test("unknown top-level key is rejected with all errors reported together", () => {
        const dir = fixturePkg({ schemaVersion: 1, bogus: true, providers: {} });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.present).toBe(true);
        const fields = result.issues.map((i) => i.field);
        expect(fields).toContain("bogus");
        expect(fields).toContain("providers");
    });

    test("unsupported schema version is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 2 });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues[0]?.field).toBe("schemaVersion");
    });

    test("duplicate service ids invalidate the overlay", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [
                { id: "github", label: "GitHub", entry: "./service.ts" },
                { id: "github", label: "GitHub 2", entry: "./service.ts" },
            ],
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.message.includes("duplicate service id"))).toBe(true);
    });

    test("invalid service id format is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, services: [{ id: "GitHub!", label: "x", entry: "./service.ts" }] });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].id")).toBe(true);
    });

    test("absolute entry path is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, services: [{ id: "svc", label: "x", entry: "/etc/passwd" }] });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.message.includes("absolute"))).toBe(true);
    });

    test("traversal (..) entry path is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, services: [{ id: "svc", label: "x", entry: "../outside.ts" }] });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.message.includes(".."))).toBe(true);
    });

    test("symlink escaping the package root is rejected", () => {
        const outsideDir = mkdtempSync(join(tmpdir(), "pizzapi-outside-"));
        dirs.push(outsideDir);
        writeFileSync(join(outsideDir, "evil.ts"), "export default {};");
        const dir = fixturePkg({ schemaVersion: 1, services: [{ id: "svc", label: "x", entry: "./link.ts" }] }, (d) => {
            symlinkSync(join(outsideDir, "evil.ts"), join(d, "link.ts"));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.message.includes("symlink"))).toBe(true);
    });

    test("entry with disallowed extension is rejected without importing it", () => {
        const dir = fixturePkg({ schemaVersion: 1, services: [{ id: "svc", label: "x", entry: "./service.json" }] }, (d) => {
            writeFileSync(join(d, "service.json"), "{}");
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].entry")).toBe(true);
    });

    test("missing sidecar (mcp path) is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./missing.json" });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "mcp" && i.message.includes("does not exist"))).toBe(true);
    });

    test("oversized sidecar (>2 MiB) is rejected", () => {
        const dir = fixturePkg({ schemaVersion: 1, mcp: "./big.json" }, (d) => {
            writeFileSync(join(d, "big.json"), "x".repeat(OVERLAY_SIDECAR_MAX_BYTES + 1));
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "mcp" && i.message.includes("exceeding"))).toBe(true);
    });

    test("panel.dir must resolve to a directory inside the package root", () => {
        const dir = fixturePkg({
            schemaVersion: 1,
            services: [{ id: "svc", label: "x", entry: "./service.ts", panel: { dir: "./service.ts" } }],
        });
        dirs.push(dir);
        const result = readOverlayManifest(dir, provenance);
        expect(result.overlay).toBeNull();
        expect(result.issues.some((i) => i.field === "services[0].panel.dir")).toBe(true);
    });
});

describe("resolveConfinedPath", () => {
    test("accepts a clean relative path inside the root", () => {
        const dir = mkdtempSync(join(tmpdir(), "pizzapi-confine-"));
        try {
            writeFileSync(join(dir, "a.ts"), "");
            const result = resolveConfinedPath(dir, "./a.ts");
            expect(result.ok).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
