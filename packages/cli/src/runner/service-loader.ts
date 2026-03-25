/**
 * Runner service plugin discovery and loading.
 *
 * Two discovery modes:
 *
 * 1. **Simple files** — Drop a `.ts` or `.js` file in `~/.pizzapi/services/`
 *    that default-exports a ServiceHandler (or a factory function).
 *
 * 2. **Plugin manifests** — A Claude Code plugin can declare runner services
 *    in its manifest (`manifest.json` or `package.json` `pizzapi.services` field).
 *    Each entry points to a module that exports a ServiceHandler.
 *
 * Both modes produce ServiceHandler instances that the daemon registers
 * alongside the built-in Terminal, FileExplorer, Git, and Tunnel services.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { ServiceHandler } from "./service-handler.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServicePluginResult {
    handler: ServiceHandler;
    source: ServicePluginSource;
}

export interface ServicePluginSource {
    /** Where this service was discovered */
    origin: "global-dir" | "project-dir" | "plugin-manifest";
    /** Absolute path to the source file or plugin directory */
    path: string;
    /** Plugin name (if from a manifest) */
    pluginName?: string;
}

export interface ServiceLoadError {
    path: string;
    error: string;
}

export interface DiscoverServicesResult {
    services: ServicePluginResult[];
    errors: ServiceLoadError[];
}

// ── Discovery directories ─────────────────────────────────────────────────────

/** Global (trusted) directory for user service plugins. */
export function globalServicesDir(): string {
    // Use process.env.HOME if set — allows tests to override without relying
    // on os.homedir() which may cache the value at process startup.
    const home = process.env.HOME || homedir();
    return join(home, ".pizzapi", "services");
}

/** Project-local directory for workspace-scoped service plugins. */
export function projectServicesDir(cwd: string): string {
    return join(cwd, ".pizzapi", "services");
}

// ── Simple file discovery ─────────────────────────────────────────────────────

const SERVICE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".mts"]);

/**
 * Scan a directory for service plugin files.
 * Each file should default-export a ServiceHandler class/instance or a factory function.
 */
async function loadServicesFromDir(
    dir: string,
    origin: "global-dir" | "project-dir",
): Promise<{ services: ServicePluginResult[]; errors: ServiceLoadError[] }> {
    const services: ServicePluginResult[] = [];
    const errors: ServiceLoadError[] = [];

    if (!existsSync(dir)) {
        return { services, errors };
    }

    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch (err) {
        errors.push({ path: dir, error: `Failed to read directory: ${err}` });
        return { services, errors };
    }

    for (const entry of entries) {
        // Skip dotfiles, test files, type declarations
        if (entry.startsWith(".") || entry.startsWith("_")) continue;
        if (entry.includes(".test.") || entry.includes(".spec.")) continue;
        if (entry.endsWith(".d.ts") || entry.endsWith(".d.mts")) continue;

        const ext = extname(entry);
        if (!SERVICE_EXTENSIONS.has(ext)) continue;

        const filePath = join(dir, entry);
        try {
            const stats = statSync(filePath);
            if (!stats.isFile()) continue;
        } catch {
            continue;
        }

        try {
            const handler = await loadServiceModule(filePath);
            if (handler) {
                services.push({
                    handler,
                    source: { origin, path: filePath },
                });
            } else {
                errors.push({
                    path: filePath,
                    error: "Module does not export a valid ServiceHandler (needs default export with id, init, dispose)",
                });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push({ path: filePath, error: msg });
        }
    }

    return { services, errors };
}

// ── Plugin manifest discovery ─────────────────────────────────────────────────

/**
 * Scan plugin directories for service declarations in manifests.
 *
 * Looks for `pizzapi.services` in `package.json` or a `services` key
 * in `manifest.json`:
 *
 * ```json
 * // package.json
 * {
 *   "pizzapi": {
 *     "services": [
 *       { "id": "system-monitor", "entry": "./services/monitor.js" }
 *     ]
 *   }
 * }
 *
 * // manifest.json
 * {
 *   "services": [
 *     { "id": "system-monitor", "entry": "./services/monitor.js" }
 *   ]
 * }
 * ```
 */
async function loadServicesFromPlugins(
    pluginDirs: string[],
): Promise<{ services: ServicePluginResult[]; errors: ServiceLoadError[] }> {
    const services: ServicePluginResult[] = [];
    const errors: ServiceLoadError[] = [];

    for (const dir of pluginDirs) {
        if (!existsSync(dir)) continue;

        let pluginEntries: string[];
        try {
            pluginEntries = readdirSync(dir);
        } catch {
            continue;
        }

        for (const pluginName of pluginEntries) {
            const pluginPath = join(dir, pluginName);
            try {
                if (!statSync(pluginPath).isDirectory()) continue;
            } catch {
                continue;
            }

            // Try package.json first, then manifest.json
            const serviceDecls = readServiceDeclarations(pluginPath, pluginName);
            if (!serviceDecls) continue;

            for (const decl of serviceDecls) {
                const entryPath = resolve(pluginPath, decl.entry);
                if (!existsSync(entryPath)) {
                    errors.push({
                        path: entryPath,
                        error: `Service entry "${decl.entry}" declared in ${pluginName} manifest does not exist`,
                    });
                    continue;
                }

                try {
                    const handler = await loadServiceModule(entryPath);
                    if (handler) {
                        // Override id if manifest specifies one
                        if (decl.id && handler.id !== decl.id) {
                            // Wrap to override id
                            const wrappedHandler: ServiceHandler = {
                                get id() { return decl.id!; },
                                init: handler.init.bind(handler),
                                dispose: handler.dispose.bind(handler),
                            };
                            services.push({
                                handler: wrappedHandler,
                                source: { origin: "plugin-manifest", path: entryPath, pluginName },
                            });
                        } else {
                            services.push({
                                handler,
                                source: { origin: "plugin-manifest", path: entryPath, pluginName },
                            });
                        }
                    } else {
                        errors.push({
                            path: entryPath,
                            error: `Module does not export a valid ServiceHandler`,
                        });
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push({ path: entryPath, error: msg });
                }
            }
        }
    }

    return { services, errors };
}

interface ServiceDeclaration {
    id?: string;
    entry: string;
}

function readServiceDeclarations(pluginDir: string, pluginName: string): ServiceDeclaration[] | null {
    // Try package.json → pizzapi.services
    const pkgPath = join(pluginDir, "package.json");
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            const services = pkg?.pizzapi?.services;
            if (Array.isArray(services) && services.length > 0) {
                return services.filter(
                    (s: any) => typeof s?.entry === "string",
                ).map((s: any) => ({
                    id: typeof s.id === "string" ? s.id : undefined,
                    entry: s.entry,
                }));
            }
        } catch {
            // Invalid JSON — skip
        }
    }

    // Try manifest.json → services
    const manifestPath = join(pluginDir, "manifest.json");
    if (existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
            const services = manifest?.services;
            if (Array.isArray(services) && services.length > 0) {
                return services.filter(
                    (s: any) => typeof s?.entry === "string",
                ).map((s: any) => ({
                    id: typeof s.id === "string" ? s.id : undefined,
                    entry: s.entry,
                }));
            }
        } catch {
            // Invalid JSON — skip
        }
    }

    return null;
}

// ── Module loading ────────────────────────────────────────────────────────────

/**
 * Load a module and extract a ServiceHandler from it.
 *
 * Supports:
 * - Default export is an object with { id, init, dispose } (instance)
 * - Default export is a class with prototype { init, dispose } (needs new)
 * - Default export is a function that returns a ServiceHandler (factory)
 */
async function loadServiceModule(filePath: string): Promise<ServiceHandler | null> {
    const mod = await import(filePath);
    const exported = mod.default ?? mod;

    // Case 1: Already a ServiceHandler instance
    if (isServiceHandler(exported)) {
        return exported;
    }

    // Case 2: Constructor function / class
    if (typeof exported === "function") {
        try {
            const instance = new exported();
            if (isServiceHandler(instance)) {
                return instance;
            }
        } catch {
            // Not a constructor — try as factory
        }

        // Case 3: Factory function
        try {
            const result = await exported();
            if (isServiceHandler(result)) {
                return result;
            }
        } catch {
            // Not a valid factory
        }
    }

    return null;
}

function isServiceHandler(obj: unknown): obj is ServiceHandler {
    if (!obj || typeof obj !== "object") return false;
    const h = obj as Record<string, unknown>;
    return (
        typeof h.id === "string" &&
        typeof h.init === "function" &&
        typeof h.dispose === "function"
    );
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface DiscoverServicesOptions {
    /** Include project-local services from .pizzapi/services/ */
    cwd?: string;
    /** Additional plugin directories to scan for manifest-declared services */
    pluginDirs?: string[];
}

/**
 * Discover and load all runner service plugins.
 *
 * Scans:
 * 1. `~/.pizzapi/services/` for simple file-based services
 * 2. Optionally `<cwd>/.pizzapi/services/` for project-local services
 * 3. Plugin directories for manifest-declared services
 */
export async function discoverServices(
    options: DiscoverServicesOptions = {},
): Promise<DiscoverServicesResult> {
    const allServices: ServicePluginResult[] = [];
    const allErrors: ServiceLoadError[] = [];
    const seenIds = new Set<string>();

    // 1. Global services directory
    const globalResult = await loadServicesFromDir(globalServicesDir(), "global-dir");
    for (const s of globalResult.services) {
        if (seenIds.has(s.handler.id)) {
            allErrors.push({
                path: s.source.path,
                error: `Duplicate service id "${s.handler.id}" — skipped (already registered)`,
            });
        } else {
            seenIds.add(s.handler.id);
            allServices.push(s);
        }
    }
    allErrors.push(...globalResult.errors);

    // 2. Project-local services directory (if cwd provided)
    if (options.cwd) {
        const projectResult = await loadServicesFromDir(
            projectServicesDir(options.cwd),
            "project-dir",
        );
        for (const s of projectResult.services) {
            if (seenIds.has(s.handler.id)) {
                allErrors.push({
                    path: s.source.path,
                    error: `Duplicate service id "${s.handler.id}" — skipped (already registered)`,
                });
            } else {
                seenIds.add(s.handler.id);
                allServices.push(s);
            }
        }
        allErrors.push(...projectResult.errors);
    }

    // 3. Plugin manifests
    if (options.pluginDirs && options.pluginDirs.length > 0) {
        const pluginResult = await loadServicesFromPlugins(options.pluginDirs);
        for (const s of pluginResult.services) {
            if (seenIds.has(s.handler.id)) {
                allErrors.push({
                    path: s.source.path,
                    error: `Duplicate service id "${s.handler.id}" — skipped (already registered)`,
                });
            } else {
                seenIds.add(s.handler.id);
                allServices.push(s);
            }
        }
        allErrors.push(...pluginResult.errors);
    }

    return { services: allServices, errors: allErrors };
}
