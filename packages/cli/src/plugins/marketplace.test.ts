import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    addMarketplace,
    defaultMarketplaceName,
    installPlugin,
    installedPluginsPath,
    isSafeName,
    listInstalledPlugins,
    listMarketplaces,
    parseMarketplaceSource,
    parsePluginRef,
    readMarketplaceCatalog,
    removeMarketplace,
    resolvePluginSource,
    setPluginEnabled,
    uninstallPlugin,
} from "./marketplace.js";

let home: string;
let originalHome: string | undefined;
let sourceRepo: string;

/** Build a fake marketplace repo on disk with one plugin. */
function makeMarketplaceRepo(root: string, name: string, plugins: any[]) {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
        join(root, ".claude-plugin", "marketplace.json"),
        JSON.stringify({ name, plugins }, null, 2),
    );
}

function makePluginDir(root: string, name: string) {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(root, "commands", "hello.md"), "# hello\n");
}

beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "pizzapi-marketplace-"));
    process.env.HOME = home;

    sourceRepo = mkdtempSync(join(tmpdir(), "pizzapi-mkt-src-"));
    makeMarketplaceRepo(sourceRepo, "demo-market", [
        { name: "demo-plugin", description: "A demo" },
        { name: "sub-plugin", description: "Subdir source", source: { source: "git", url: "https://example.invalid/x.git", path: "pkgs/sub" } },
    ]);
    makePluginDir(join(sourceRepo, "plugins", "demo-plugin"), "demo-plugin");
});

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(sourceRepo, { recursive: true, force: true });
});

// ── Source parsing ────────────────────────────────────────────────────────────

describe("parseMarketplaceSource", () => {
    test("recognizes owner/repo as github", () => {
        expect(parseMarketplaceSource("anthropics/claude-plugins-official")).toEqual({
            source: "github",
            repo: "anthropics/claude-plugins-official",
        });
    });

    test("recognizes git URLs", () => {
        expect(parseMarketplaceSource("https://github.com/a/b.git")).toEqual({
            source: "git",
            url: "https://github.com/a/b.git",
        });
        expect((parseMarketplaceSource("git@github.com:a/b.git") as any).source).toBe("git");
    });

    test("recognizes local paths", () => {
        const parsed = parseMarketplaceSource("/tmp/some/market") as any;
        expect(parsed.source).toBe("local");
        expect(parsed.path).toBe("/tmp/some/market");
    });

    test("rejects junk", () => {
        expect(parseMarketplaceSource("not a source")).toHaveProperty("error");
        expect(parseMarketplaceSource("  ")).toHaveProperty("error");
    });
});

describe("defaultMarketplaceName", () => {
    test("derives a name from each source kind", () => {
        expect(defaultMarketplaceName({ source: "github", repo: "a/b" })).toBe("b");
        expect(defaultMarketplaceName({ source: "git", url: "https://x.dev/a/cool-market.git" })).toBe("cool-market");
        expect(defaultMarketplaceName({ source: "local", path: "/tmp/my-market" })).toBe("my-market");
    });
});

describe("isSafeName", () => {
    test("rejects traversal and separators", () => {
        expect(isSafeName("good-name")).toBe(true);
        expect(isSafeName("../evil")).toBe(false);
        expect(isSafeName("a/b")).toBe(false);
        expect(isSafeName("")).toBe(false);
    });
});

// ── Marketplace lifecycle ─────────────────────────────────────────────────────

describe("addMarketplace", () => {
    test("registers a local marketplace and reads its catalog", () => {
        const result = addMarketplace(sourceRepo);
        expect(result.pluginCount).toBe(2);
        // Manifest name wins over the temp directory name.
        expect(result.name).toBe("demo-market");

        const known = listMarketplaces();
        expect(known[result.name]).toBeDefined();
        expect(known[result.name].installLocation).toBe(result.installLocation);
        expect(existsSync(join(result.installLocation, ".claude-plugin", "marketplace.json"))).toBe(true);

        const catalog = readMarketplaceCatalog(result.name)!;
        expect(catalog.plugins.map((p) => p.name)).toEqual(["demo-plugin", "sub-plugin"]);
    });

    test("honors an explicit name", () => {
        const result = addMarketplace(sourceRepo, { name: "custom" });
        expect(result.name).toBe("custom");
        expect(Object.keys(listMarketplaces())).toEqual(["custom"]);
    });

    test("rejects unsafe names", () => {
        expect(() => addMarketplace(sourceRepo, { name: "../escape" })).toThrow(/Invalid marketplace name/);
    });

    test("rejects a source with no marketplace manifest and cleans up", () => {
        const empty = mkdtempSync(join(tmpdir(), "pizzapi-empty-"));
        try {
            expect(() => addMarketplace(empty)).toThrow(/marketplace.json/);
            expect(listMarketplaces()).toEqual({});
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });

    test("re-adding refreshes in place", () => {
        const first = addMarketplace(sourceRepo, { name: "demo" });
        const second = addMarketplace(sourceRepo, { name: "demo" });
        expect(second.installLocation).toBe(first.installLocation);
        expect(Object.keys(listMarketplaces())).toEqual(["demo"]);
    });
});

describe("removeMarketplace", () => {
    test("removes registration and files", () => {
        const { name, installLocation } = addMarketplace(sourceRepo, { name: "demo" });
        expect(removeMarketplace(name)).toBe(true);
        expect(listMarketplaces()).toEqual({});
        expect(existsSync(installLocation)).toBe(false);
    });

    test("returns false for unknown marketplaces", () => {
        expect(removeMarketplace("nope")).toBe(false);
    });
});

describe("readMarketplaceCatalog", () => {
    test("returns null for unknown or unsafe names", () => {
        expect(readMarketplaceCatalog("missing")).toBeNull();
        expect(readMarketplaceCatalog("../etc")).toBeNull();
    });
});

// ── Plugin source resolution ──────────────────────────────────────────────────

describe("resolvePluginSource", () => {
    test("defaults to plugins/<name> inside the marketplace repo", () => {
        expect(resolvePluginSource({ name: "x" }, "/mkt")).toEqual({
            source: { source: "local", path: "/mkt/plugins/x" },
        });
    });

    test("handles github and git-subdir entries", () => {
        expect(resolvePluginSource({ name: "x", source: { source: "github", repo: "a/b" } as any }, "/mkt"))
            .toEqual({ source: { source: "github", repo: "a/b" }, subdir: undefined });

        expect(resolvePluginSource(
            { name: "x", source: { source: "git-subdir", url: "https://x.dev/a.git", path: "plugins/x" } as any },
            "/mkt",
        )).toEqual({ source: { source: "git", url: "https://x.dev/a.git" }, subdir: "plugins/x" });
    });

    test("handles a plain relative-path source", () => {
        expect(resolvePluginSource({ name: "x", source: "./local/x" as any }, "/mkt")).toEqual({
            source: { source: "local", path: "/mkt/local/x" },
        });
    });
});

// ── Install / enable ──────────────────────────────────────────────────────────

describe("installPlugin", () => {
    test("installs from the marketplace repo, records it, and enables it", () => {
        addMarketplace(sourceRepo, { name: "demo" });
        const result = installPlugin("demo-plugin@demo");

        expect(result.installPath).toContain(join("plugins", "cache", "demo", "demo-plugin"));
        expect(existsSync(join(result.installPath, ".claude-plugin", "plugin.json"))).toBe(true);

        const installed = JSON.parse(readFileSync(installedPluginsPath(), "utf-8"));
        expect(installed.plugins["demo-plugin@demo"][0].installPath).toBe(result.installPath);

        const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
        expect(settings.enabledPlugins["demo-plugin@demo"]).toBe(true);

        expect(listInstalledPlugins()).toEqual([
            { key: "demo-plugin@demo", installPath: result.installPath, enabled: true },
        ]);
    });

    test("resolves a bare plugin name to its only marketplace", () => {
        addMarketplace(sourceRepo, { name: "demo" });
        expect(parsePluginRef("demo-plugin")).toEqual({ plugin: "demo-plugin", marketplace: "demo" });
    });

    test("errors for unknown plugins and marketplaces", () => {
        addMarketplace(sourceRepo, { name: "demo" });
        expect(() => installPlugin("ghost@demo")).toThrow(/not found in demo/);
        expect(() => installPlugin("demo-plugin@ghost")).toThrow(/Unknown marketplace/);
        expect(parsePluginRef("ghost")).toHaveProperty("error");
    });
});

describe("uninstallPlugin", () => {
    test("removes the payload, registration, and enabled flag", () => {
        addMarketplace(sourceRepo, { name: "demo" });
        const { installPath } = installPlugin("demo-plugin@demo");

        expect(uninstallPlugin("demo-plugin@demo")).toBe(true);
        expect(existsSync(installPath)).toBe(false);
        expect(listInstalledPlugins()).toEqual([]);

        const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
        expect(settings.enabledPlugins["demo-plugin@demo"]).toBeUndefined();
    });

    test("returns false when the plugin isn't installed", () => {
        addMarketplace(sourceRepo, { name: "demo" });
        expect(uninstallPlugin("demo-plugin@demo")).toBe(false);
    });
});

describe("setPluginEnabled", () => {
    test("toggles enabledPlugins without dropping other settings", () => {
        mkdirSync(join(home, ".claude"), { recursive: true });
        writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "sonnet" }));

        setPluginEnabled("x@y", false);
        const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
        expect(settings.model).toBe("sonnet");
        expect(settings.enabledPlugins["x@y"]).toBe(false);

        setPluginEnabled("x@y", true);
        expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).enabledPlugins["x@y"]).toBe(true);
    });

    test("installed-but-disabled plugins report enabled: false", () => {
        addMarketplace(sourceRepo, { name: "demo" });
        installPlugin("demo-plugin@demo");
        setPluginEnabled("demo-plugin@demo", false);
        expect(listInstalledPlugins()[0].enabled).toBe(false);
    });
});
