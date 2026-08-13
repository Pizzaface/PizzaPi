/**
 * Claude Code marketplace write-side.
 *
 * `discover.ts` already *reads* Claude Code's marketplace state; this module
 * adds the missing writes so `/plugin marketplace add …` and `pizza plugins
 * install …` work. All state stays in Claude Code's own files so the two tools
 * can share an install:
 *
 *   ~/.claude/plugins/known_marketplaces.json   marketplace name → source + installLocation
 *   ~/.claude/plugins/marketplaces/<name>/      cloned marketplace repo
 *   ~/.claude/plugins/cache/<mkt>/<plugin>/     installed plugin payloads
 *   ~/.claude/plugins/installed_plugins.json    "<plugin>@<mkt>" → installations[]
 *   ~/.claude/settings.json  enabledPlugins     "<plugin>@<mkt>" → boolean
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ClaudeInstalledPluginEntry } from "./types.js";

// ── Paths ─────────────────────────────────────────────────────────────────────

function claudeHome(): string {
    return join(process.env.HOME || homedir(), ".claude");
}

export function pluginsRoot(): string {
    return join(claudeHome(), "plugins");
}

export function knownMarketplacesPath(): string {
    return join(pluginsRoot(), "known_marketplaces.json");
}

export function installedPluginsPath(): string {
    return join(pluginsRoot(), "installed_plugins.json");
}

export function marketplacesDir(): string {
    return join(pluginsRoot(), "marketplaces");
}

export function pluginCacheDir(): string {
    return join(pluginsRoot(), "cache");
}

function claudeSettingsPath(): string {
    return join(claudeHome(), "settings.json");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MarketplaceSource {
    source: "github" | "git" | "local";
    repo?: string;
    url?: string;
    path?: string;
}

export interface KnownMarketplace {
    source: MarketplaceSource;
    installLocation: string;
    lastUpdated?: string;
}

export interface MarketplacePluginEntry {
    name: string;
    description?: string;
    category?: string;
    homepage?: string;
    author?: { name?: string } | string;
    source?: unknown;
}

export interface MarketplaceCatalog {
    name: string;
    description?: string;
    plugins: MarketplacePluginEntry[];
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

function readJson<T>(path: string, fallback: T): T {
    if (!existsSync(path)) return fallback;
    try {
        return JSON.parse(readFileSync(path, "utf-8")) as T;
    } catch {
        return fallback;
    }
}

function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

// ── Source parsing ────────────────────────────────────────────────────────────

/** Marketplace/plugin names we're willing to create directories for. */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isSafeName(name: string): boolean {
    return SAFE_NAME.test(name) && !name.includes("..");
}

/**
 * Parse a marketplace spec into a source descriptor.
 *
 *   owner/repo                    → github
 *   https://…/x.git, git@…:x.git  → git
 *   ./path, /abs/path, ~/path     → local
 */
export function parseMarketplaceSource(spec: string): MarketplaceSource | { error: string } {
    const raw = spec.trim();
    if (!raw) return { error: "Marketplace source is required" };

    if (raw.startsWith("~/")) {
        return { source: "local", path: join(homedir(), raw.slice(2)) };
    }
    if (raw.startsWith(".") || isAbsolute(raw)) {
        return { source: "local", path: resolve(raw) };
    }
    if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(raw)) {
        return { source: "git", url: raw };
    }
    if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
        return { source: "github", repo: raw };
    }
    return { error: `Unrecognized marketplace source: ${spec}` };
}

/** Default marketplace directory name for a source (overridable by the caller). */
export function defaultMarketplaceName(source: MarketplaceSource): string {
    if (source.source === "github" && source.repo) return source.repo.split("/")[1];
    if (source.source === "git" && source.url) {
        const tail = source.url.replace(/\.git$/, "").split(/[/:]/).pop() ?? "";
        return tail;
    }
    if (source.source === "local" && source.path) return source.path.split("/").filter(Boolean).pop() ?? "";
    return "";
}

function gitUrlFor(source: MarketplaceSource): string | null {
    if (source.source === "github" && source.repo) return `https://github.com/${source.repo}.git`;
    if (source.source === "git" && source.url) return source.url;
    return null;
}

// ── Fetching ──────────────────────────────────────────────────────────────────

export type Fetcher = (source: MarketplaceSource, dest: string) => void;

/** Shallow-clone (or copy, for local sources) a marketplace/plugin into `dest`. */
export const defaultFetcher: Fetcher = (source, dest) => {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });

    if (source.source === "local") {
        const from = source.path!;
        if (!existsSync(from)) throw new Error(`Local source not found: ${from}`);
        cpSync(from, dest, { recursive: true });
        return;
    }

    const url = gitUrlFor(source);
    if (!url) throw new Error("Marketplace source has no URL");
    execFileSync("git", ["clone", "--depth", "1", url, dest], { stdio: "pipe" });
};

// ── Marketplaces ──────────────────────────────────────────────────────────────

export function listMarketplaces(): Record<string, KnownMarketplace> {
    return readJson<Record<string, KnownMarketplace>>(knownMarketplacesPath(), {});
}

export interface AddMarketplaceResult {
    name: string;
    installLocation: string;
    pluginCount: number;
}

/**
 * Add (or re-fetch) a marketplace and register it in known_marketplaces.json.
 * Throws on fetch failure or when the fetched repo has no marketplace manifest.
 */
export function addMarketplace(spec: string, opts?: { name?: string; fetcher?: Fetcher }): AddMarketplaceResult {
    const parsed = parseMarketplaceSource(spec);
    if ("error" in parsed) throw new Error(parsed.error);

    let name = (opts?.name ?? defaultMarketplaceName(parsed)).trim();
    if (!isSafeName(name)) throw new Error(`Invalid marketplace name: "${name}"`);

    let installLocation = join(marketplacesDir(), name);
    (opts?.fetcher ?? defaultFetcher)(parsed, installLocation);

    let catalog = readCatalogAt(installLocation, name);
    if (!catalog) {
        rmSync(installLocation, { recursive: true, force: true });
        throw new Error(`No .claude-plugin/marketplace.json found in ${spec}`);
    }

    // Without an explicit name, the manifest's own name wins over the directory
    // /repo name so plugin refs read as `plugin@<manifest name>`.
    if (!opts?.name && catalog.name !== name && isSafeName(catalog.name)) {
        const renamed = join(marketplacesDir(), catalog.name);
        rmSync(renamed, { recursive: true, force: true });
        renameSync(installLocation, renamed);
        name = catalog.name;
        installLocation = renamed;
        catalog = readCatalogAt(installLocation, name)!;
    }

    const known = listMarketplaces();
    known[name] = { source: parsed, installLocation, lastUpdated: new Date().toISOString() };
    writeJson(knownMarketplacesPath(), known);

    return { name, installLocation, pluginCount: catalog.plugins.length };
}

/** Remove a marketplace registration and its cloned copy. Returns false if unknown. */
export function removeMarketplace(name: string): boolean {
    const known = listMarketplaces();
    const entry = known[name];
    if (!entry) return false;
    delete known[name];
    writeJson(knownMarketplacesPath(), known);
    if (isSafeName(name)) {
        rmSync(entry.installLocation || join(marketplacesDir(), name), { recursive: true, force: true });
    }
    return true;
}

/** Read a marketplace's plugin catalog. Returns null when it isn't installed. */
export function readMarketplaceCatalog(name: string): MarketplaceCatalog | null {
    if (!isSafeName(name)) return null;
    const known = listMarketplaces()[name];
    return readCatalogAt(known?.installLocation || join(marketplacesDir(), name), name);
}

/** Read a catalog from a specific directory (used before registration). */
function readCatalogAt(root: string, fallbackName: string): MarketplaceCatalog | null {
    const manifest = join(root, ".claude-plugin", "marketplace.json");
    if (!existsSync(manifest)) return null;
    const data = readJson<Partial<MarketplaceCatalog>>(manifest, {});
    if (!Array.isArray(data.plugins)) return null;
    return {
        name: typeof data.name === "string" ? data.name : fallbackName,
        description: data.description,
        plugins: data.plugins.filter((p): p is MarketplacePluginEntry => !!p && typeof p.name === "string"),
    };
}

// ── Plugin install / enable ───────────────────────────────────────────────────

export interface PluginRef {
    plugin: string;
    marketplace: string;
}

/** Parse "name@marketplace" (marketplace optional when only one is known). */
export function parsePluginRef(spec: string): PluginRef | { error: string } {
    const raw = spec.trim();
    const at = raw.lastIndexOf("@");
    if (at > 0) {
        const plugin = raw.slice(0, at);
        const marketplace = raw.slice(at + 1);
        if (!isSafeName(plugin) || !isSafeName(marketplace)) return { error: `Invalid plugin reference: ${spec}` };
        return { plugin, marketplace };
    }
    if (!isSafeName(raw)) return { error: `Invalid plugin reference: ${spec}` };

    // Prefer an already-installed plugin, then fall back to marketplace catalogs.
    const installedOwners = listInstalledPlugins()
        .map((p) => p.key)
        .filter((key) => key.slice(0, key.lastIndexOf("@")) === raw)
        .map((key) => key.slice(key.lastIndexOf("@") + 1));
    const owners = installedOwners.length > 0
        ? [...new Set(installedOwners)]
        : Object.keys(listMarketplaces()).filter((m) =>
            readMarketplaceCatalog(m)?.plugins.some((p) => p.name === raw),
        );
    if (owners.length === 0) return { error: `Plugin not found in any marketplace: ${raw}` };
    if (owners.length > 1) return { error: `Plugin "${raw}" exists in ${owners.join(", ")} — use ${raw}@<marketplace>` };
    return { plugin: raw, marketplace: owners[0] };
}

/**
 * Resolve a catalog entry's `source` field into a fetchable source + subdir.
 * Supports the shapes Claude Code publishes: github, git/git-subdir (url+path),
 * and plain relative paths inside the marketplace repo.
 */
export function resolvePluginSource(
    entry: MarketplacePluginEntry,
    marketplaceRoot: string,
): { source: MarketplaceSource; subdir?: string } {
    const src = entry.source as Record<string, unknown> | string | undefined;

    // No source, or a relative path → the plugin lives inside the marketplace repo.
    if (!src) return { source: { source: "local", path: join(marketplaceRoot, "plugins", entry.name) } };
    if (typeof src === "string") {
        return src.startsWith("http") || src.includes("://")
            ? { source: { source: "git", url: src } }
            : { source: { source: "local", path: resolve(marketplaceRoot, src) } };
    }

    const kind = typeof src.source === "string" ? src.source : "";
    const url = typeof src.url === "string" ? src.url : undefined;
    const repo = typeof src.repo === "string" ? src.repo : undefined;
    const subdir = typeof src.path === "string" ? src.path : undefined;

    if (kind === "github" && repo) return { source: { source: "github", repo }, subdir };
    if (url) return { source: { source: "git", url }, subdir };
    if (subdir) return { source: { source: "local", path: resolve(marketplaceRoot, subdir) } };
    return { source: { source: "local", path: join(marketplaceRoot, "plugins", entry.name) } };
}

export interface InstallResult {
    plugin: string;
    marketplace: string;
    installPath: string;
}

/** Install a plugin from a known marketplace and enable it. */
export function installPlugin(spec: string, opts?: { fetcher?: Fetcher }): InstallResult {
    const ref = parsePluginRef(spec);
    if ("error" in ref) throw new Error(ref.error);

    const catalog = readMarketplaceCatalog(ref.marketplace);
    if (!catalog) throw new Error(`Unknown marketplace: ${ref.marketplace}`);
    const entry = catalog.plugins.find((p) => p.name === ref.plugin);
    if (!entry) throw new Error(`Plugin "${ref.plugin}" not found in ${ref.marketplace}`);

    const marketplaceRoot = listMarketplaces()[ref.marketplace]?.installLocation
        ?? join(marketplacesDir(), ref.marketplace);
    const { source, subdir } = resolvePluginSource(entry, marketplaceRoot);

    const installPath = join(pluginCacheDir(), ref.marketplace, ref.plugin);
    const fetcher = opts?.fetcher ?? defaultFetcher;

    if (subdir && source.source !== "local") {
        // Clone the whole repo to a scratch dir, then keep only the subdir.
        // ponytail: full shallow clone, sparse-checkout if repo size ever hurts.
        const scratch = `${installPath}.tmp`;
        try {
            fetcher(source, scratch);
            const from = join(scratch, subdir);
            if (!existsSync(from)) throw new Error(`Subdirectory "${subdir}" not found in plugin source`);
            rmSync(installPath, { recursive: true, force: true });
            mkdirSync(dirname(installPath), { recursive: true });
            cpSync(from, installPath, { recursive: true });
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    } else {
        fetcher(source, installPath);
    }

    const key = `${ref.plugin}@${ref.marketplace}`;
    const installed = readJson<{ version?: number; plugins?: Record<string, ClaudeInstalledPluginEntry[]> }>(
        installedPluginsPath(),
        { version: 1, plugins: {} },
    );
    installed.version ??= 1;
    installed.plugins ??= {};
    installed.plugins[key] = [{
        scope: "user",
        installPath,
        version: typeof (entry as { version?: string }).version === "string" ? (entry as { version?: string }).version! : "0.0.0",
        lastUpdated: new Date().toISOString(),
    }];
    writeJson(installedPluginsPath(), installed);

    setPluginEnabled(key, true);
    return { plugin: ref.plugin, marketplace: ref.marketplace, installPath };
}

/** Uninstall a plugin: drop its cache copy, registration, and enabled flag. */
export function uninstallPlugin(spec: string): boolean {
    const ref = parsePluginRef(spec);
    if ("error" in ref) throw new Error(ref.error);
    const key = `${ref.plugin}@${ref.marketplace}`;

    const installed = readJson<{ version?: number; plugins?: Record<string, ClaudeInstalledPluginEntry[]> }>(
        installedPluginsPath(),
        { version: 1, plugins: {} },
    );
    const entries = installed.plugins?.[key];
    if (!entries) return false;

    for (const entry of entries) {
        // Only delete paths we manage, never an arbitrary path from the file.
        if (entry.installPath?.startsWith(pluginCacheDir())) {
            rmSync(entry.installPath, { recursive: true, force: true });
        }
    }
    delete installed.plugins![key];
    writeJson(installedPluginsPath(), installed);

    const settings = readJson<Record<string, any>>(claudeSettingsPath(), {});
    if (settings.enabledPlugins && key in settings.enabledPlugins) {
        delete settings.enabledPlugins[key];
        writeJson(claudeSettingsPath(), settings);
    }
    return true;
}

/** List installed plugin keys ("name@marketplace") with their enabled state. */
export function listInstalledPlugins(): Array<{ key: string; installPath: string; enabled: boolean }> {
    const installed = readJson<{ plugins?: Record<string, ClaudeInstalledPluginEntry[]> }>(installedPluginsPath(), {});
    const settings = readJson<{ enabledPlugins?: Record<string, boolean> }>(claudeSettingsPath(), {});
    const out: Array<{ key: string; installPath: string; enabled: boolean }> = [];
    for (const [key, entries] of Object.entries(installed.plugins ?? {})) {
        const first = Array.isArray(entries) ? entries[0] : undefined;
        if (!first) continue;
        out.push({ key, installPath: first.installPath, enabled: settings.enabledPlugins?.[key] !== false });
    }
    return out;
}

/** Flip a plugin's `enabledPlugins` entry in ~/.claude/settings.json. */
export function setPluginEnabled(key: string, enabled: boolean): void {
    const settings = readJson<Record<string, any>>(claudeSettingsPath(), {});
    settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [key]: enabled };
    writeJson(claudeSettingsPath(), settings);
}

/** Resolve a user-supplied plugin spec to its "name@marketplace" key. */
export function resolvePluginKey(spec: string): string {
    const ref = parsePluginRef(spec);
    if ("error" in ref) throw new Error(ref.error);
    return `${ref.plugin}@${ref.marketplace}`;
}
