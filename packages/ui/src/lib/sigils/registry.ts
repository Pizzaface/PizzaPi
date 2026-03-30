import type { SigilRenderConfig } from "./types";
import type { ServiceSigilDef } from "@pizzapi/protocol";

// ── Built-in type configurations ─────────────────────────────────────────────

const BUILTIN_CONFIGS: Record<string, SigilRenderConfig> = {
  file: {
    label: "File",
    icon: "file",
    colorClass: "bg-blue-500/15 text-blue-700 dark:text-blue-400 ring-blue-500/25",
  },
  pr: {
    label: "PR",
    icon: "git-pull-request",
    colorClass: "bg-purple-500/15 text-purple-700 dark:text-purple-400 ring-purple-500/25",
  },
  issue: {
    label: "Issue",
    icon: "circle-dot",
    colorClass: "bg-green-500/15 text-green-700 dark:text-green-400 ring-green-500/25",
  },
  commit: {
    label: "Commit",
    icon: "git-commit-horizontal",
    colorClass: "bg-amber-500/15 text-amber-700 dark:text-amber-400 ring-amber-500/25",
  },
  branch: {
    label: "Branch",
    icon: "git-branch",
    colorClass: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 ring-cyan-500/25",
  },
  repo: {
    label: "Repo",
    icon: "book-marked",
    colorClass: "bg-slate-500/15 text-slate-700 dark:text-slate-400 ring-slate-500/25",
  },
  check: {
    label: "CI Check",
    icon: "check-circle",
    colorClass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 ring-emerald-500/25",
  },
  status: {
    label: "Status",
    icon: "circle",
    colorClass: "bg-blue-500/15 text-blue-700 dark:text-blue-400 ring-blue-500/25",
  },
  error: {
    label: "Error",
    icon: "alert-triangle",
    colorClass: "bg-red-500/15 text-red-700 dark:text-red-400 ring-red-500/25",
  },
  cost: {
    label: "Cost",
    icon: "dollar-sign",
    colorClass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 ring-emerald-500/25",
  },
  duration: {
    label: "Duration",
    icon: "clock",
    colorClass: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 ring-indigo-500/25",
  },
  session: {
    label: "Session",
    icon: "terminal",
    colorClass: "bg-violet-500/15 text-violet-700 dark:text-violet-400 ring-violet-500/25",
  },
  model: {
    label: "Model",
    icon: "brain",
    colorClass: "bg-pink-500/15 text-pink-700 dark:text-pink-400 ring-pink-500/25",
  },
  cmd: {
    label: "Command",
    icon: "terminal-square",
    colorClass: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400 ring-zinc-500/25",
  },
  tag: {
    label: "Tag",
    icon: "tag",
    colorClass: "bg-orange-500/15 text-orange-700 dark:text-orange-400 ring-orange-500/25",
  },
  test: {
    label: "Test",
    icon: "flask-conical",
    colorClass: "bg-teal-500/15 text-teal-700 dark:text-teal-400 ring-teal-500/25",
  },
  link: {
    label: "Link",
    icon: "external-link",
    colorClass: "bg-blue-500/15 text-blue-700 dark:text-blue-400 ring-blue-500/25",
  },
  diff: {
    label: "Diff",
    icon: "diff",
    colorClass: "bg-amber-500/15 text-amber-700 dark:text-amber-400 ring-amber-500/25",
  },
};

// ── Alias map ────────────────────────────────────────────────────────────────

/** Built-in type aliases: alternative names → canonical type. */
const BUILTIN_ALIASES: Record<string, string> = {
  "pull-request": "pr",
  mr: "pr",
  sha: "commit",
  "git-branch": "branch",
  ref: "branch",
  "git-commit": "commit",
  repository: "repo",
  ci: "check",
  workflow: "check",
  bash: "cmd",
  shell: "cmd",
  bug: "issue",
  ticket: "issue",
  url: "link",
  href: "link",
  price: "cost",
  budget: "cost",
  time: "duration",
  elapsed: "duration",
  environment: "link",
  env: "link",
  agent: "model",
  llm: "model",
  warn: "error",
  notice: "error",
};

// ── Fallback config ──────────────────────────────────────────────────────────

const FALLBACK_CONFIG: SigilRenderConfig = {
  label: "Reference",
  icon: "hash",
  colorClass: "bg-muted text-muted-foreground ring-border",
};

// ── Registry class ───────────────────────────────────────────────────────────

export class SigilRegistry {
  private configs: Map<string, SigilRenderConfig>;
  private aliases: Map<string, string>;
  private serviceDefs: Map<string, ServiceSigilDef>;

  constructor() {
    this.configs = new Map(Object.entries(BUILTIN_CONFIGS));
    this.aliases = new Map(Object.entries(BUILTIN_ALIASES));
    this.serviceDefs = new Map();
  }

  /**
   * Seed the registry with sigil definitions from runner services.
   * Service defs provide metadata (label, description) and alias overrides.
   */
  seedFromServiceDefs(defs: ServiceSigilDef[]): void {
    this.serviceDefs.clear();
    for (const def of defs) {
      this.serviceDefs.set(def.type, def);

      // Register aliases from service defs
      if (def.aliases) {
        for (const alias of def.aliases) {
          this.aliases.set(alias, def.type);
        }
      }

      // If the service provides a label and there's no built-in config,
      // create one with the fallback styling
      if (!this.configs.has(def.type)) {
        this.configs.set(def.type, {
          label: def.label,
          icon: def.icon ?? FALLBACK_CONFIG.icon,
          colorClass: FALLBACK_CONFIG.colorClass,
        });
      } else if (def.icon) {
        // Service-provided icon overrides the built-in icon
        const existing = this.configs.get(def.type)!;
        this.configs.set(def.type, { ...existing, icon: def.icon });
      }
    }
  }

  /** Resolve a type name through aliases to its canonical type. */
  resolveType(type: string): string {
    return this.aliases.get(type) ?? type;
  }

  /** Get the render config for a type (after alias resolution). */
  getConfig(type: string): SigilRenderConfig {
    const canonical = this.resolveType(type);
    return this.configs.get(canonical) ?? FALLBACK_CONFIG;
  }

  /** Get the service definition for a type (if registered by a service). */
  getServiceDef(type: string): ServiceSigilDef | undefined {
    const canonical = this.resolveType(type);
    return this.serviceDefs.get(canonical);
  }

  /** Get the label for display — prefer service def label, fall back to config. */
  getLabel(type: string): string {
    const canonical = this.resolveType(type);
    const serviceDef = this.serviceDefs.get(canonical);
    if (serviceDef?.label) return serviceDef.label;
    return this.configs.get(canonical)?.label ?? type;
  }

  /** Get the description (from service def only). */
  getDescription(type: string): string | undefined {
    const canonical = this.resolveType(type);
    return this.serviceDefs.get(canonical)?.description;
  }
}

/** Create a fresh registry, optionally seeded with service defs. */
export function createRegistry(defs?: ServiceSigilDef[]): SigilRegistry {
  const registry = new SigilRegistry();
  if (defs && defs.length > 0) {
    registry.seedFromServiceDefs(defs);
  }
  return registry;
}
