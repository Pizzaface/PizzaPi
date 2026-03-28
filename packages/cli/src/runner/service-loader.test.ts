import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    discoverServices,
    globalServicesDir,
    projectServicesDir,
    type ServiceManifest,
} from "./service-loader.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), "pizzapi-service-loader-"));
}

/** Write a valid ServiceHandler module to a file */
function writeHandler(dir: string, filename: string, id: string): string {
    const path = join(dir, filename);
    writeFileSync(
        path,
        `export default class implements Object {
  get id() { return "${id}"; }
  init() {}
  dispose() {}
}
`,
    );
    return path;
}

/** Write a class-based ServiceHandler */
function writeClassHandler(dir: string, filename: string, id: string): string {
    const path = join(dir, filename);
    writeFileSync(
        path,
        `export default class MyService {
  get id() { return "${id}"; }
  init(socket, opts) {}
  dispose() {}
}
`,
    );
    return path;
}

/** Write an instance-based ServiceHandler */
function writeInstanceHandler(dir: string, filename: string, id: string): string {
    const path = join(dir, filename);
    writeFileSync(
        path,
        `const handler = {
  id: "${id}",
  init(socket, opts) {},
  dispose() {},
};
export default handler;
`,
    );
    return path;
}

/** Write a factory-function ServiceHandler */
function writeFactoryHandler(dir: string, filename: string, id: string): string {
    const path = join(dir, filename);
    writeFileSync(
        path,
        `export default function() {
  return {
    id: "${id}",
    init(socket, opts) {},
    dispose() {},
  };
}
`,
    );
    return path;
}

/** Write a broken module (syntax error) */
function writeBrokenModule(dir: string, filename: string): string {
    const path = join(dir, filename);
    writeFileSync(path, `this is not valid javascript !!!`);
    return path;
}

/** Write a module with no valid export */
function writeInvalidExport(dir: string, filename: string): string {
    const path = join(dir, filename);
    writeFileSync(path, `export default 42;`);
    return path;
}

// ── globalServicesDir / projectServicesDir ────────────────────────────────────

describe("globalServicesDir", () => {
    test("returns a path under HOME", () => {
        const dir = globalServicesDir();
        expect(dir).toContain(".pizzapi");
        expect(dir).toContain("services");
    });
});

describe("projectServicesDir", () => {
    test("returns <cwd>/.pizzapi/services", () => {
        const dir = projectServicesDir("/some/project");
        expect(dir).toBe("/some/project/.pizzapi/services");
    });
});

// ── discoverServices — simple files ──────────────────────────────────────────

describe("discoverServices — simple file discovery", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir();
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("returns empty result when services dir does not exist", async () => {
        // Override HOME to a tmp dir that has no services dir
        const origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        try {
            const result = await discoverServices();
            expect(result.services).toHaveLength(0);
            expect(result.errors).toHaveLength(0);
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("loads a class-based handler from global dir", async () => {
        const servicesDir = join(tmpDir, ".pizzapi", "services");
        mkdirSync(servicesDir, { recursive: true });
        writeClassHandler(servicesDir, "my-service.js", "my-service");

        const origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        try {
            const result = await discoverServices();
            expect(result.errors).toHaveLength(0);
            expect(result.services).toHaveLength(1);
            expect(result.services[0].handler.id).toBe("my-service");
            expect(result.services[0].source.origin).toBe("global-dir");
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("loads an instance-based handler", async () => {
        const servicesDir = join(tmpDir, ".pizzapi", "services");
        mkdirSync(servicesDir, { recursive: true });
        writeInstanceHandler(servicesDir, "instance.js", "instance-svc");

        const origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        try {
            const result = await discoverServices();
            expect(result.services).toHaveLength(1);
            expect(result.services[0].handler.id).toBe("instance-svc");
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("loads a factory-function handler", async () => {
        const servicesDir = join(tmpDir, ".pizzapi", "services");
        mkdirSync(servicesDir, { recursive: true });
        writeFactoryHandler(servicesDir, "factory.js", "factory-svc");

        const origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        try {
            const result = await discoverServices();
            expect(result.services).toHaveLength(1);
            expect(result.services[0].handler.id).toBe("factory-svc");
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("loads project-local services when cwd provided", async () => {
        const cwdDir = join(tmpDir, "project");
        mkdirSync(join(cwdDir, ".pizzapi", "services"), { recursive: true });
        writeInstanceHandler(join(cwdDir, ".pizzapi", "services"), "local.js", "local-svc");

        const origHome = process.env.HOME;
        process.env.HOME = tmpDir; // no global services
        try {
            const result = await discoverServices({ cwd: cwdDir });
            expect(result.services).toHaveLength(1);
            expect(result.services[0].handler.id).toBe("local-svc");
            expect(result.services[0].source.origin).toBe("project-dir");
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("skips dotfiles and test files", async () => {
        const servicesDir = join(tmpDir, ".pizzapi", "services");
        mkdirSync(servicesDir, { recursive: true });
        writeInstanceHandler(servicesDir, ".hidden.js", "hidden-svc");
        writeInstanceHandler(servicesDir, "my-service.test.js", "test-svc");
        writeInstanceHandler(servicesDir, "my-service.spec.js", "spec-svc");
        writeInstanceHandler(servicesDir, "valid.js", "valid-svc");

        const origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        try {
            const result = await discoverServices();
            expect(result.services).toHaveLength(1);
            expect(result.services[0].handler.id).toBe("valid-svc");
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("records error for invalid export (non-handler)", async () => {
        const servicesDir = join(tmpDir, ".pizzapi", "services");
        mkdirSync(servicesDir, { recursive: true });
        writeInvalidExport(servicesDir, "bad.js");

        const origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        try {
            const result = await discoverServices();
            expect(result.services).toHaveLength(0);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].error).toContain("does not export a valid ServiceHandler");
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("deduplicates services with the same id — global wins over project-local", async () => {
        const globalServicesDir = join(tmpDir, ".pizzapi", "services");
        mkdirSync(globalServicesDir, { recursive: true });
        writeInstanceHandler(globalServicesDir, "global.js", "duplicate-id");

        const cwdDir = join(tmpDir, "project");
        const localServicesDir = join(cwdDir, ".pizzapi", "services");
        mkdirSync(localServicesDir, { recursive: true });
        writeInstanceHandler(localServicesDir, "local.js", "duplicate-id");

        const origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        try {
            const result = await discoverServices({ cwd: cwdDir });
            // Global wins — only 1 service registered
            expect(result.services).toHaveLength(1);
            expect(result.services[0].source.origin).toBe("global-dir");
            // Error recorded for the duplicate project-local
            expect(result.errors.some(e => e.error.includes("Duplicate service id"))).toBe(true);
        } finally {
            process.env.HOME = origHome;
        }
    });
});

// ── discoverServices — plugin manifest discovery ──────────────────────────────

describe("discoverServices — plugin manifest discovery", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir();
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    test("loads service declared in package.json pizzapi.services", async () => {
        const pluginsDir = join(tmpDir, "plugins");
        const pluginDir = join(pluginsDir, "my-plugin");
        const servicesDir = join(pluginDir, "services");
        mkdirSync(servicesDir, { recursive: true });

        writeInstanceHandler(servicesDir, "monitor.js", "system-monitor");

        writeFileSync(
            join(pluginDir, "package.json"),
            JSON.stringify({
                name: "my-plugin",
                pizzapi: {
                    services: [{ id: "system-monitor", entry: "./services/monitor.js" }],
                },
            }),
        );

        const origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        try {
            const result = await discoverServices({ pluginDirs: [pluginsDir] });
            expect(result.errors).toHaveLength(0);
            expect(result.services).toHaveLength(1);
            expect(result.services[0].handler.id).toBe("system-monitor");
            expect(result.services[0].source.origin).toBe("plugin-manifest");
            expect(result.services[0].source.pluginName).toBe("my-plugin");
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("loads service declared in manifest.json", async () => {
        const pluginsDir = join(tmpDir, "plugins");
        const pluginDir = join(pluginsDir, "another-plugin");
        mkdirSync(pluginDir, { recursive: true });

        writeInstanceHandler(pluginDir, "service.js", "manifest-svc");

        writeFileSync(
            join(pluginDir, "manifest.json"),
            JSON.stringify({
                services: [{ id: "manifest-svc", entry: "./service.js" }],
            }),
        );

        const origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        try {
            const result = await discoverServices({ pluginDirs: [pluginsDir] });
            expect(result.services).toHaveLength(1);
            expect(result.services[0].handler.id).toBe("manifest-svc");
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("records error for manifest entry that does not exist", async () => {
        const pluginsDir = join(tmpDir, "plugins");
        const pluginDir = join(pluginsDir, "bad-plugin");
        mkdirSync(pluginDir, { recursive: true });

        writeFileSync(
            join(pluginDir, "manifest.json"),
            JSON.stringify({
                services: [{ id: "ghost-svc", entry: "./nonexistent.js" }],
            }),
        );

        const origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        try {
            const result = await discoverServices({ pluginDirs: [pluginsDir] });
            expect(result.services).toHaveLength(0);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].error).toContain("does not exist");
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("skips plugin dirs that don't have service declarations", async () => {
        const pluginsDir = join(tmpDir, "plugins");
        const pluginDir = join(pluginsDir, "no-services-plugin");
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(
            join(pluginDir, "package.json"),
            JSON.stringify({ name: "no-services-plugin" }),
        );

        const origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        try {
            const result = await discoverServices({ pluginDirs: [pluginsDir] });
            expect(result.services).toHaveLength(0);
            expect(result.errors).toHaveLength(0);
        } finally {
            process.env.HOME = origHome;
        }
    });

    test("handles multiple services in one plugin", async () => {
        const pluginsDir = join(tmpDir, "plugins");
        const pluginDir = join(pluginsDir, "multi-svc-plugin");
        mkdirSync(pluginDir, { recursive: true });

        writeInstanceHandler(pluginDir, "svc-a.js", "svc-a");
        writeInstanceHandler(pluginDir, "svc-b.js", "svc-b");

        writeFileSync(
            join(pluginDir, "package.json"),
            JSON.stringify({
                pizzapi: {
                    services: [
                        { id: "svc-a", entry: "./svc-a.js" },
                        { id: "svc-b", entry: "./svc-b.js" },
                    ],
                },
            }),
        );

        const origHome = process.env.HOME;
        process.env.HOME = tmpDir;
        try {
            const result = await discoverServices({ pluginDirs: [pluginsDir] });
            expect(result.services).toHaveLength(2);
            const ids = result.services.map(s => s.handler.id).sort();
            expect(ids).toEqual(["svc-a", "svc-b"]);
        } finally {
            process.env.HOME = origHome;
        }
    });
});

// ── Folder-based service discovery ────────────────────────────────────────────

describe("discoverServices — folder-based services", () => {
    let tmpDir: string;
    let servicesDir: string;
    let origHome: string;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        servicesDir = join(tmpDir, ".pizzapi", "services");
        mkdirSync(servicesDir, { recursive: true });
        origHome = process.env.HOME!;
        process.env.HOME = tmpDir;
    });

    afterEach(() => {
        process.env.HOME = origHome;
        rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeFolderService(name: string, manifest: Record<string, unknown>, handlerId?: string): string {
        const dir = join(servicesDir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        const id = handlerId ?? (manifest.id as string) ?? name;
        writeFileSync(
            join(dir, "index.ts"),
            `export default class {
  get id() { return "${id}"; }
  init() {}
  dispose() {}
}
`,
        );
        return dir;
    }

    test("loads a folder-based service with manifest.json", async () => {
        writeFolderService("my-panel", {
            id: "my-panel",
            label: "My Panel",
            icon: "activity",
            panel: { dir: "./panel" },
        });

        const result = await discoverServices();
        expect(result.errors).toHaveLength(0);
        expect(result.services).toHaveLength(1);
        expect(result.services[0].handler.id).toBe("my-panel");
        expect(result.services[0].manifest).toBeDefined();
        expect(result.services[0].manifest!.label).toBe("My Panel");
        expect(result.services[0].manifest!.icon).toBe("activity");
        expect(result.services[0].manifest!.panel).toEqual({ dir: "./panel" });
    });

    test("uses default icon when not specified in manifest", async () => {
        writeFolderService("no-icon", {
            id: "no-icon",
            label: "No Icon Service",
        });

        const result = await discoverServices();
        expect(result.services).toHaveLength(1);
        expect(result.services[0].manifest!.icon).toBe("square");
    });

    test("errors when manifest is missing required fields", async () => {
        const dir = join(servicesDir, "bad-manifest");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({ icon: "cpu" }));
        writeFileSync(join(dir, "index.ts"), `export default { id: "bad", init() {}, dispose() {} };`);

        const result = await discoverServices();
        expect(result.services).toHaveLength(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].error).toContain("missing required");
    });

    test("errors when entry point does not exist", async () => {
        const dir = join(servicesDir, "no-entry");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({
            id: "no-entry",
            label: "No Entry",
            entry: "./missing.ts",
        }));

        const result = await discoverServices();
        expect(result.services).toHaveLength(0);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].error).toContain("does not exist");
    });

    test("skips directories without manifest.json", async () => {
        const dir = join(servicesDir, "no-manifest");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "index.ts"), `export default { id: "nm", init() {}, dispose() {} };`);

        const result = await discoverServices();
        expect(result.services).toHaveLength(0);
        expect(result.errors).toHaveLength(0);
    });

    test("coexists with file-based services", async () => {
        writeFolderService("folder-svc", {
            id: "folder-svc",
            label: "Folder Service",
            icon: "box",
            panel: {},
        });
        writeHandler(servicesDir, "file-svc.ts", "file-svc");

        const result = await discoverServices();
        expect(result.errors).toHaveLength(0);
        expect(result.services).toHaveLength(2);
        const ids = result.services.map(s => s.handler.id).sort();
        expect(ids).toEqual(["file-svc", "folder-svc"]);
        const folderResult = result.services.find(s => s.handler.id === "folder-svc");
        const fileResult = result.services.find(s => s.handler.id === "file-svc");
        expect(folderResult!.manifest).toBeDefined();
        expect(fileResult!.manifest).toBeUndefined();
    });

    test("respects custom entry path in manifest", async () => {
        const dir = join(servicesDir, "custom-entry");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({
            id: "custom-entry",
            label: "Custom Entry",
            entry: "./service.ts",
        }));
        writeFileSync(
            join(dir, "service.ts"),
            `export default { id: "custom-entry", init() {}, dispose() {} };`,
        );

        const result = await discoverServices();
        expect(result.errors).toHaveLength(0);
        expect(result.services).toHaveLength(1);
        expect(result.services[0].handler.id).toBe("custom-entry");
    });

    test("parses triggers[] from manifest.json", async () => {
        writeFolderService("trigger-svc", {
            id: "trigger-svc",
            label: "Trigger Service",
            icon: "zap",
            triggers: [
                {
                    type: "trigger-svc:thing_happened",
                    label: "Thing Happened",
                    description: "Fires when a thing happens",
                    schema: { type: "object", properties: { thingId: { type: "string" } } },
                },
                {
                    type: "trigger-svc:other_event",
                    label: "Other Event",
                },
            ],
        });

        const result = await discoverServices();
        expect(result.errors).toHaveLength(0);
        expect(result.services).toHaveLength(1);
        const manifest = result.services[0].manifest!;
        expect(manifest.triggers).toHaveLength(2);
        expect(manifest.triggers![0].type).toBe("trigger-svc:thing_happened");
        expect(manifest.triggers![0].label).toBe("Thing Happened");
        expect(manifest.triggers![0].description).toBe("Fires when a thing happens");
        expect(manifest.triggers![0].schema).toEqual({ type: "object", properties: { thingId: { type: "string" } } });
        expect(manifest.triggers![1].type).toBe("trigger-svc:other_event");
        expect(manifest.triggers![1].label).toBe("Other Event");
        expect(manifest.triggers![1].description).toBeUndefined();
        expect(manifest.triggers![1].schema).toBeUndefined();
    });

    test("skips invalid trigger entries (missing type or label)", async () => {
        writeFolderService("partial-triggers", {
            id: "partial-triggers",
            label: "Partial Triggers",
            triggers: [
                { type: "ok:valid", label: "Valid" },
                { type: "missing-label" },                    // no label → skipped
                { label: "Missing Type" },                    // no type → skipped
                null,                                         // null → skipped
                { type: 42, label: "Bad type field" },        // non-string type → skipped
                { type: "also:valid", label: "Also Valid", description: 99 }, // bad desc → allowed (omitted)
            ],
        });

        const result = await discoverServices();
        expect(result.errors).toHaveLength(0);
        expect(result.services).toHaveLength(1);
        const triggers = result.services[0].manifest!.triggers!;
        // Only the two valid ones survive
        expect(triggers).toHaveLength(2);
        expect(triggers[0].type).toBe("ok:valid");
        expect(triggers[1].type).toBe("also:valid");
        expect(triggers[1].description).toBeUndefined(); // bad description omitted
    });

    test("manifest.triggers is undefined when no triggers declared", async () => {
        writeFolderService("no-triggers", { id: "no-triggers", label: "No Triggers" });

        const result = await discoverServices();
        expect(result.errors).toHaveLength(0);
        expect(result.services).toHaveLength(1);
        expect(result.services[0].manifest!.triggers).toBeUndefined();
    });

    test("manifest.triggers is undefined when triggers is empty array", async () => {
        writeFolderService("empty-triggers", { id: "empty-triggers", label: "Empty", triggers: [] });

        const result = await discoverServices();
        expect(result.errors).toHaveLength(0);
        expect(result.services).toHaveLength(1);
        expect(result.services[0].manifest!.triggers).toBeUndefined();
    });
});
