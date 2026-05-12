import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionProvider } from "./types";

export function globalProvidersDir(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".pizzapi", "providers");
}

export function projectProvidersDir(cwd: string): string {
  return join(cwd, ".pizzapi", "providers");
}

export interface ProviderPluginResult {
  provider: ExtensionProvider;
  source: ProviderSource;
}

export interface ProviderSource {
  origin: "global" | "project";
  path: string;
}

export interface ProviderLoadError {
  path: string;
  error: string;
}

export interface DiscoverProvidersResult {
  providers: ProviderPluginResult[];
  errors: ProviderLoadError[];
}

export interface DiscoverProvidersOptions {
  cwd?: string;
  /** Allow project-local providers. Default: false. */
  allowProject?: boolean;
}

function validateProvider(obj: unknown, sourcePath: string): ExtensionProvider | null {
  if (!obj || typeof obj !== "object") return null;
  const p = obj as Record<string, unknown>;

  if (typeof p.id !== "string" || !p.id) return null;
  if (!Array.isArray(p.capabilities)) return null;
  if (typeof p.init !== "function" || typeof p.dispose !== "function") return null;

  if (p.capabilities.includes("context") && typeof p.onBeforeAgentStart !== "function") return null;

  if (p.capabilities.includes("lifecycle")) {
    const hasMethod =
      typeof p.onSessionStart === "function" ||
      typeof p.onSessionShutdown === "function" ||
      typeof p.onTurnEnd === "function" ||
      typeof p.onSessionClose === "function";
    if (!hasMethod) return null;
  }

  if (p.capabilities.includes("ui-panel")) {
    const hasUI = p.panel !== undefined || p.sidebarWidgets !== undefined || p.sessionMetadataCards !== undefined;
    if (!hasUI) return null;
  }

  if (p.capabilities.includes("metadata") && typeof p.getSessionMetadata !== "function") return null;

  return p as unknown as ExtensionProvider;
}

async function loadProviderModule(filePath: string): Promise<{ provider: ExtensionProvider | null; error?: string }> {
  try {
    const mod = await import(filePath);
    const exported = mod.default ?? mod;

    if (typeof exported === "function") {
      try {
        const instance = new exported();
        return { provider: validateProvider(instance, filePath) };
      } catch (err) {
        const ctorErr = err instanceof Error ? err.message : String(err);
        try {
          const result = await exported();
          return { provider: validateProvider(result, filePath) };
        } catch (err2) {
          return { provider: null, error: `Constructor failed: ${ctorErr}; async factory also failed: ${err2 instanceof Error ? err2.message : String(err2)}` };
        }
      }
    }

    return { provider: validateProvider(exported, filePath) };
  } catch (err) {
    return { provider: null, error: `Import failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function scanProvidersDir(
  dir: string,
  origin: "global" | "project",
): Promise<{ providers: ProviderPluginResult[]; errors: ProviderLoadError[] }> {
  const providers: ProviderPluginResult[] = [];
  const errors: ProviderLoadError[] = [];

  if (!existsSync(dir)) return { providers, errors };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    errors.push({ path: dir, error: `Failed to read: ${err}` });
    return { providers, errors };
  }

  for (const entry of entries) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    const entryPath = join(dir, entry);
    let stats;
    try { stats = statSync(entryPath); } catch { continue; }

    if (stats.isDirectory()) {
      const indexPath = join(entryPath, "index.ts");
      if (!existsSync(indexPath)) continue;

      const loaded = await loadProviderModule(indexPath);
      if (loaded.provider) {
        providers.push({ provider: loaded.provider, source: { origin, path: entryPath } });
      } else {
        const detail = loaded.error ? `: ${loaded.error}` : "";
        errors.push({ path: indexPath, error: `Module does not export a valid ExtensionProvider${detail}` });
      }
    }
  }

  return { providers, errors };
}

export async function discoverProviders(
  options: DiscoverProvidersOptions = {},
): Promise<DiscoverProvidersResult> {
  const allProviders: ProviderPluginResult[] = [];
  const allErrors: ProviderLoadError[] = [];
  const seenIds = new Set<string>();

  const globalResult = await scanProvidersDir(globalProvidersDir(), "global");
  for (const p of globalResult.providers) {
    seenIds.add(p.provider.id);
    allProviders.push(p);
  }
  allErrors.push(...globalResult.errors);

  if (options.cwd && options.allowProject) {
    const projectResult = await scanProvidersDir(projectProvidersDir(options.cwd), "project");
    for (const p of projectResult.providers) {
      if (seenIds.has(p.provider.id)) {
        allErrors.push({ path: p.source.path, error: `Duplicate provider ID "${p.provider.id}" — skipped` });
      } else {
        seenIds.add(p.provider.id);
        allProviders.push(p);
      }
    }
    allErrors.push(...projectResult.errors);
  }

  return { providers: allProviders, errors: allErrors };
}
