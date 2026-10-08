/**
 * Plugin view data types, payload normalizer, and command context. Kept apart
 * from PluginsView.tsx so App/SessionViewer can import them without pulling the
 * (lazy-loaded) view into the main bundle.
 */
import * as React from "react";

// ── Types (mirror packages/cli/src/plugins/info.ts) ──────────────────────────

export interface PluginCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

export interface PluginInfo {
  name: string;
  description: string;
  rootPath: string;
  commands: PluginCommand[];
  hookEvents: string[];
  skills: { name: string; dirPath?: string }[];
  agents?: { name: string }[];
  rules: { name: string }[];
  hasMcp: boolean;
  hasAgents: boolean;
  hasLsp?: boolean;
  version?: string;
  author?: string;
  source?: "marketplace" | "directory" | "project";
  key?: string;
  marketplace?: string;
}

export interface DisabledPluginInfo {
  key: string;
  name: string;
  marketplace?: string;
}

export interface MarketplaceInfo {
  name: string;
  source: string;
  pluginCount: number;
  description?: string;
  lastUpdated?: string;
}

export interface PiPackageInfo {
  source: string;
  scope: "user" | "project";
  filtered?: boolean;
  installedPath?: string;
}

export interface PluginsOverview {
  plugins: PluginInfo[];
  disabled: DisabledPluginInfo[];
  marketplaces: MarketplaceInfo[];
  /** Configured pi packages. */
  packages: PiPackageInfo[];
  /** Project dir `--local` package installs target (in-session only). */
  packagesCwd?: string;
}

export interface MarketplaceCatalogInfo {
  name: string;
  description?: string;
  plugins: Array<{
    name: string;
    key: string;
    description?: string;
    category?: string;
    installed: boolean;
    enabled: boolean;
  }>;
}

export interface PluginsViewData {
  notice?: string;
  isError?: boolean;
  overview: PluginsOverview;
  catalog?: MarketplaceCatalogInfo;
}

/** Runs `/plugin <args>`. Resolve when the command was accepted. */
export type PluginCommandHandler = (args: string[]) => Promise<unknown> | void;

/** In-session provider: sends `/plugin …` to the session so it reloads after changes. */
export const PluginCommandContext = React.createContext<PluginCommandHandler | null>(null);

/** Number of `/plugin` result cards in the transcript — a card that sent a command waits for this to change. */
export const PluginResultCountContext = React.createContext(0);

const EMPTY_OVERVIEW: PluginsOverview = { plugins: [], disabled: [], marketplaces: [], packages: [] };

/** Coerce an untrusted payload (relay event / HTTP body) into view data. */
export function toPluginsViewData(raw: unknown): PluginsViewData {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const o = (r.overview && typeof r.overview === "object" ? r.overview : {}) as Record<string, unknown>;
  const arr = <T,>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
  const catalog = r.catalog && typeof r.catalog === "object" ? (r.catalog as MarketplaceCatalogInfo) : undefined;
  return {
    notice: typeof r.notice === "string" ? r.notice : undefined,
    isError: r.isError === true,
    overview: {
      ...EMPTY_OVERVIEW,
      // Older runners / caches may omit list fields — default them.
      plugins: arr<PluginInfo>(o.plugins).map((p) => ({
        ...p,
        commands: arr(p.commands),
        hookEvents: arr(p.hookEvents),
        skills: arr(p.skills),
        agents: arr(p.agents),
        rules: arr(p.rules),
      })),
      disabled: arr<DisabledPluginInfo>(o.disabled),
      marketplaces: arr<MarketplaceInfo>(o.marketplaces),
      packages: arr<PiPackageInfo>(o.packages),
      packagesCwd: typeof o.packagesCwd === "string" ? o.packagesCwd : undefined,
    },
    catalog: catalog ? { ...catalog, plugins: arr(catalog.plugins) } : undefined,
  };
}

