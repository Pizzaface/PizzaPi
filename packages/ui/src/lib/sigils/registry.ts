import type { SigilRenderConfig } from "./types";
import type { ServiceSigilDef } from "@pizzapi/protocol";

// ── Built-in type configurations ─────────────────────────────────────────────

const BUILTIN_CONFIGS: Record<string, SigilRenderConfig> = {
  file: {
    label: "File",
    icon: "file",
    colorClass: "bg-blue-500/20 text-blue-800 dark:text-blue-300 ring-blue-500/35",
  },
  pr: {
    label: "PR",
    icon: "git-pull-request",
    colorClass: "bg-purple-500/20 text-purple-800 dark:text-purple-300 ring-purple-500/35",
  },
  issue: {
    label: "Issue",
    icon: "circle-dot",
    colorClass: "bg-green-500/20 text-green-800 dark:text-green-300 ring-green-500/35",
  },
  commit: {
    label: "Commit",
    icon: "git-commit-horizontal",
    colorClass: "bg-amber-500/20 text-amber-800 dark:text-amber-300 ring-amber-500/35",
  },
  branch: {
    label: "Branch",
    icon: "git-branch",
    colorClass: "bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 ring-cyan-500/35",
  },
  repo: {
    label: "Repo",
    icon: "book-marked",
    colorClass: "bg-slate-500/20 text-slate-800 dark:text-slate-300 ring-slate-500/35",
  },
  check: {
    label: "CI Check",
    icon: "check-circle",
    colorClass: "bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 ring-emerald-500/35",
  },
  status: {
    label: "Status",
    icon: "circle",
    colorClass: "bg-blue-500/20 text-blue-800 dark:text-blue-300 ring-blue-500/35",
  },
  error: {
    label: "Error",
    icon: "alert-triangle",
    colorClass: "bg-red-500/20 text-red-800 dark:text-red-300 ring-red-500/35",
  },
  cost: {
    label: "Cost",
    icon: "dollar-sign",
    colorClass: "bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 ring-emerald-500/35",
  },
  duration: {
    label: "Duration",
    icon: "clock",
    colorClass: "bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 ring-indigo-500/35",
  },
  time: {
    label: "Time",
    icon: "clock",
    colorClass: "bg-sky-500/20 text-sky-800 dark:text-sky-300 ring-sky-500/35",
  },
  countdown: {
    label: "Countdown",
    icon: "timer",
    colorClass: "bg-rose-500/20 text-rose-800 dark:text-rose-300 ring-rose-500/35",
  },
  session: {
    label: "Session",
    icon: "terminal",
    colorClass: "bg-violet-500/20 text-violet-800 dark:text-violet-300 ring-violet-500/35",
  },
  model: {
    label: "Model",
    icon: "brain",
    colorClass: "bg-pink-500/20 text-pink-800 dark:text-pink-300 ring-pink-500/35",
  },
  cmd: {
    label: "Command",
    icon: "terminal-square",
    colorClass: "bg-zinc-500/20 text-zinc-800 dark:text-zinc-300 ring-zinc-500/35",
  },
  tag: {
    label: "Tag",
    icon: "tag",
    colorClass: "bg-orange-500/20 text-orange-800 dark:text-orange-300 ring-orange-500/35",
  },
  test: {
    label: "Test",
    icon: "flask-conical",
    colorClass: "bg-teal-500/20 text-teal-800 dark:text-teal-300 ring-teal-500/35",
  },
  link: {
    label: "Link",
    icon: "external-link",
    colorClass: "bg-blue-500/20 text-blue-800 dark:text-blue-300 ring-blue-500/35",
  },
  diff: {
    label: "Diff",
    icon: "diff",
    colorClass: "bg-amber-500/20 text-amber-800 dark:text-amber-300 ring-amber-500/35",
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
  elapsed: "duration",
  timestamp: "time",
  when: "time",
  at: "time",
  timer: "countdown",
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
