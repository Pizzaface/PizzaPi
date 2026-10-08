/**
 * Shared Claude-plugin management view — rendered by the in-session `/plugin`
 * card and the runner panel's Plugins tab. Data is the structured result of a
 * `/plugin` run (see packages/cli/src/extensions/plugin-command.ts); every
 * action is expressed as `/plugin` args handed to `onCommand`. Without
 * `onCommand` the view is read-only.
 */
import * as React from "react";
import { AlertTriangle, ArrowLeft, Check, ChevronDown, Copy, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  type MarketplaceCatalogInfo,
  type PiPackageInfo,
  type PluginCommandHandler,
  type PluginInfo,
  type PluginsViewData,
} from "./plugins-data";

export * from "./plugins-data";

// Claude Code hook event → pi event it is adapted to (null = not adapted).
const HOOK_EVENT_MAPPING: Record<string, string | null> = {
  PreToolUse: "tool_call",
  PostToolUse: "tool_result",
  PostToolUseFailure: "tool_result",
  UserPromptSubmit: "input",
  Stop: "agent_end",
  SessionStart: "session_start",
  SessionEnd: "session_shutdown",
  PreCompact: "session_before_compact",
};

// ── Action plumbing ──────────────────────────────────────────────────────────

const ActionContext = React.createContext<{
  run: (id: string, args: string[]) => void;
  pending: string | null;
} | null>(null);

/**
 * Button that runs a `/plugin` command. `confirm` makes it two-click for
 * destructive actions. Renders nothing in read-only views.
 */
function ActionButton({ id, args, label, confirm, icon, variant = "ghost" }: {
  id: string;
  args: string[];
  label: string;
  confirm?: boolean;
  icon?: React.ReactNode;
  variant?: "outline" | "ghost" | "default";
}) {
  const ctx = React.useContext(ActionContext);
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  if (!ctx) return null;
  const busy = ctx.pending === id;
  return (
    <Button
      type="button"
      size="sm"
      variant={armed ? "destructive" : variant}
      className={cn("h-6 px-2 text-[11px]", variant === "ghost" && !armed && "text-muted-foreground hover:text-foreground")}
      disabled={ctx.pending !== null}
      onClick={(e) => {
        e.stopPropagation();
        if (confirm && !armed) { setArmed(true); return; }
        setArmed(false);
        ctx.run(id, args);
      }}
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : icon}
      {armed ? `Confirm ${label.toLowerCase()}?` : label}
    </Button>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Section({ title, count, children, action, collapsible, defaultOpen = true }: {
  title: string;
  count?: number;
  children: React.ReactNode;
  action?: React.ReactNode;
  /** Render the header as an accordion toggle. */
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen || !collapsible);
  const headingClass = "flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground";
  const heading = (
    <>
      {title}
      {count !== undefined && <span className="font-normal tabular-nums">{count}</span>}
    </>
  );
  return (
    <section className="py-2.5">
      <div className={cn("flex min-h-6 items-center justify-between px-3", open && "pb-1")}>
        <h4 className={headingClass}>
          {collapsible ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className={cn(headingClass, "-mx-1 rounded px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}
            >
              <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
              {heading}
            </button>
          ) : heading}
        </h4>
        {open && action}
      </div>
      {open && <ul className="flex flex-col px-1.5">{children}</ul>}
    </section>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** ["2 commands", "3 skills", "1 hook"] — zero counts omitted. */
function capabilitySummary(p: PluginInfo): string[] {
  return ([
    [p.commands.length, "command"],
    [p.skills.length, "skill"],
    [p.agents?.length ?? 0, "agent"],
    [p.hookEvents.length, "hook"],
    [p.rules.length, "rule"],
  ] as const).filter(([n]) => n > 0).map(([n, w]) => plural(n, w));
}

function sourceLabel(p: PluginInfo): string | null {
  if (p.source === "marketplace") return `@${p.marketplace ?? "marketplace"}`;
  if (p.source === "project") return "project";
  if (p.source === "directory") return "local dir";
  return null;
}

function CopyChip({ text, title }: { text: string; title?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      title={title ? `${title} — click to copy` : "Click to copy"}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {text}
      {copied ? <Check className="size-2.5 text-green-600 dark:text-green-500" /> : <Copy className="size-2.5 opacity-50" />}
    </button>
  );
}

function NameList({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-[10px] font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1">
        {names.map((n) => (
          <span key={n} className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">{n}</span>
        ))}
      </div>
    </div>
  );
}

function PluginRow({ plugin }: { plugin: PluginInfo }) {
  const [open, setOpen] = React.useState(false);
  const key = plugin.key ?? plugin.name;
  const summary = capabilitySummary(plugin);
  const unadapted = [plugin.hasMcp && "MCP", plugin.hasLsp && "LSP"].filter(Boolean).join(" + ");
  const meta = [plugin.version && `v${plugin.version}`, sourceLabel(plugin), plugin.author && `by ${plugin.author}`].filter(Boolean).join(" · ");
  return (
    <li className={cn("rounded-md", open && "bg-muted/20")}>
      <div className="flex items-start gap-2 px-1.5 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} details for ${plugin.name}`}
          className="flex min-w-0 flex-1 items-start gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronDown className={cn("mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
          <div className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs font-medium text-foreground">{plugin.name}</span>
            {plugin.description && <p className={cn("mt-0.5 text-[11px] text-muted-foreground", !open && "line-clamp-1")}>{plugin.description}</p>}
            {(summary.length > 0 || unadapted) && (
              <p className="mt-0.5 flex flex-wrap gap-x-1 text-[10px] text-muted-foreground">
                {summary.map((item, i) => (
                  <span key={item} className="whitespace-nowrap">{i > 0 && "· "}{item}</span>
                ))}
                {unadapted && (
                  <span className="whitespace-nowrap text-amber-600 dark:text-amber-500" title="Not adapted (Claude Code–only)">
                    {summary.length > 0 && "· "}<AlertTriangle className="mb-px mr-0.5 inline size-2.5" />{unadapted} not adapted
                  </span>
                )}
              </p>
            )}
          </div>
        </button>
        <div className="-mt-1">
          <ActionButton id={`disable:${key}`} args={["disable", key]} label="Disable" />
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-2 px-6 pb-2.5 pt-0.5">
          {plugin.commands.length > 0 && (
            <div>
              <p className="mb-1 text-[10px] font-medium text-muted-foreground">Commands</p>
              <div className="flex flex-wrap gap-1">
                {plugin.commands.map((c) => (
                  <CopyChip key={c.name} text={`/${plugin.name}:${c.name}`} title={[c.argumentHint, c.description].filter(Boolean).join(" — ")} />
                ))}
              </div>
            </div>
          )}
          <NameList label="Skills" names={plugin.skills.map((s) => s.name)} />
          <NameList label="Agents" names={(plugin.agents ?? []).map((a) => a.name)} />
          <NameList
            label="Hooks"
            names={plugin.hookEvents.map((e) => {
              const mapped = HOOK_EVENT_MAPPING[e];
              return mapped ? `${e} → ${mapped}` : `${e} (not adapted)`;
            })}
          />
          <NameList label="Rules" names={plugin.rules.map((r) => r.name)} />
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={plugin.rootPath}>
              {meta || plugin.rootPath}
            </p>
            {plugin.source === "marketplace" && (
              <ActionButton id={`uninstall:${key}`} args={["uninstall", key]} label="Uninstall" confirm />
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** Text input + submit that runs a `/plugin` command for a source string. */
function SourceForm({ id, placeholder, label, submitLabel, toArgs, localLabel }: {
  id: string;
  submitLabel: string;
  placeholder: string;
  label: string;
  toArgs: (source: string, local: boolean) => string[];
  /** Shows a "project scope" checkbox when set. */
  localLabel?: string;
}) {
  const ctx = React.useContext(ActionContext);
  const [value, setValue] = React.useState("");
  const [local, setLocal] = React.useState(false);
  if (!ctx) return null;
  const source = value.trim();
  return (
    <form
      className="flex flex-wrap items-center gap-1.5 px-1.5 pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!source) return;
        ctx.run(id, toArgs(source, local));
        setValue("");
      }}
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-7 min-w-48 flex-1 text-xs"
      />
      <div className="ml-auto flex items-center gap-1.5">
        {localLabel && (
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title="Install into the project's .pizzapi/settings.json instead of your user settings">
            <input type="checkbox" className="size-3.5 accent-primary" checked={local} onChange={(e) => setLocal(e.target.checked)} />
            {localLabel}
          </label>
        )}
        <Button type="submit" size="sm" className="h-7 px-2.5 text-xs" disabled={!source || ctx.pending !== null}>
          {ctx.pending === id && <Loader2 className="size-3 animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function PackageRow({ pkg }: { pkg: PiPackageInfo }) {
  const scopeArgs = pkg.scope === "project" ? ["--local"] : [];
  const tags = [pkg.scope === "project" && "project", pkg.filtered && "filtered"].filter(Boolean).join(" · ");
  return (
    <li className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/20">
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate font-mono text-xs text-foreground" title={pkg.installedPath ?? pkg.source}>{pkg.source}</span>
        {tags && (
          <span
            className="shrink-0 text-[10px] text-muted-foreground"
            title={pkg.filtered ? "Only some of this package's resources are enabled" : undefined}
          >
            {tags}
          </span>
        )}
      </span>
      <ActionButton id={`pkg-update:${pkg.scope}:${pkg.source}`} args={["package", "update", pkg.source]} label="Update" />
      <ActionButton id={`pkg-remove:${pkg.scope}:${pkg.source}`} args={["package", "remove", pkg.source, ...scopeArgs]} label="Remove" confirm />
    </li>
  );
}

const CATALOG_PAGE = 10;

/** Marketplace browse mode: searchable, category-filtered, paged catalog. */
function CatalogBrowser({ catalog, onBack }: { catalog: MarketplaceCatalogInfo; onBack: () => void }) {
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<string | null>(null);
  const [limit, setLimit] = React.useState(CATALOG_PAGE);

  const categories = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of catalog.plugins) if (p.category) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [catalog.plugins]);

  const q = query.trim().toLowerCase();
  const matches = catalog.plugins.filter((p) =>
    (!category || p.category === category) &&
    (!q || `${p.name} ${p.description ?? ""} ${p.category ?? ""}`.toLowerCase().includes(q)));
  const shown = matches.slice(0, limit);
  // Reset paging when the filter changes.
  React.useEffect(() => setLimit(CATALOG_PAGE), [q, category]);

  return (
    <section className="flex flex-col gap-3 px-3 py-3">
      <div className="flex items-start gap-2">
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground" onClick={onBack}>
          <ArrowLeft className="size-3" />Back
        </Button>
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-medium text-foreground">
            {catalog.name}
            <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">{plural(catalog.plugins.length, "plugin")}</span>
          </h4>
          {catalog.description && <p className="mt-0.5 text-xs text-muted-foreground">{catalog.description}</p>}
        </div>
      </div>

      {catalog.plugins.length > 8 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins"
            aria-label="Search plugins"
            className="h-8 pl-7 text-xs"
          />
        </div>
      )}

      {categories.length > 1 && (
        <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none]">
          {[null, ...categories].map((c) => (
            <button
              key={c ?? "all"}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] capitalize transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                category === c
                  ? "border-foreground/30 bg-foreground/10 text-foreground"
                  : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
            >
              {c ?? "All"}
            </button>
          ))}
        </div>
      )}

      {matches.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">No plugins match.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/40">
          {shown.map((p) => (
            <li key={p.key} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-mono text-xs font-medium text-foreground">{p.name}</span>
                  {p.category && !category && <span className="shrink-0 text-[10px] capitalize text-muted-foreground">{p.category}</span>}
                </div>
                {p.description && <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground" title={p.description}>{p.description}</p>}
              </div>
              <div className="shrink-0">
                {!p.installed ? (
                  <ActionButton id={`install:${p.key}`} args={["install", p.key]} label="Install" variant="outline" />
                ) : p.enabled ? (
                  <span className="inline-flex h-6 items-center gap-1 px-2 text-[11px] text-muted-foreground"><Check className="size-3" />Installed</span>
                ) : (
                  <ActionButton id={`enable:${p.key}`} args={["enable", p.key]} label="Enable" />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {matches.length > shown.length && (
        <Button type="button" variant="ghost" size="sm" className="h-7 self-center text-xs text-muted-foreground" onClick={() => setLimit((n) => n + CATALOG_PAGE)}>
          Show more ({matches.length - shown.length} left)
        </Button>
      )}
    </section>
  );
}

// ── Main view ────────────────────────────────────────────────────────────────

export type PluginsViewSection = "plugins" | "packages";

export function PluginsView({ data, onCommand, className, loading, sections = ["plugins", "packages"] }: {
  data: PluginsViewData;
  /** A command is in flight on the runner — shows a status line and dims the stale view. */
  loading?: boolean;
  onCommand?: PluginCommandHandler;
  className?: string;
  /** Which groups to render: Claude plugins (+ marketplaces) and/or pi packages. */
  sections?: PluginsViewSection[];
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  const actions = React.useMemo(() => onCommand
    ? {
        pending,
        run: (id: string, args: string[]) => {
          setPending(id);
          void Promise.resolve(onCommand(args)).catch(() => {}).finally(() => setPending(null));
        },
      }
    : null, [onCommand, pending]);

  const { overview } = data;
  const showPlugins = sections.includes("plugins");
  const showPackages = sections.includes("packages");
  // Browse mode outlives the result that opened it: an install/enable result
  // carries no catalog, so keep browsing and re-derive install state from the
  // fresh overview. Back is purely local — every result carries the overview.
  const [browsing, setBrowsing] = React.useState(data.catalog);
  const [seenCatalog, setSeenCatalog] = React.useState(data.catalog);
  if (data.catalog !== seenCatalog) {
    setSeenCatalog(data.catalog);
    if (data.catalog) setBrowsing(data.catalog);
  }
  const catalog = React.useMemo(() => {
    if (!showPlugins || !browsing) return undefined;
    const enabled = new Set(overview.plugins.map((p) => p.key).filter(Boolean));
    const disabled = new Set(overview.disabled.map((p) => p.key));
    return {
      ...browsing,
      plugins: browsing.plugins.map((p) => ({
        ...p,
        enabled: enabled.has(p.key),
        installed: enabled.has(p.key) || disabled.has(p.key),
      })),
    };
  }, [showPlugins, browsing, overview]);
  const projectName = overview.packagesCwd?.split(/[\\/]/).filter(Boolean).pop();

  return (
    <ActionContext.Provider value={actions}>
      <div className={cn("divide-y divide-border/40", className)} aria-busy={loading || undefined}>
        {loading && (
          <p role="status" className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />Loading from runner…
          </p>
        )}
        <div className={cn("divide-y divide-border/40", loading && "pointer-events-none opacity-50")}>
        {data.notice && (
          <p
            role={data.isError ? "alert" : "status"}
            className={cn("whitespace-pre-wrap px-3 py-2 text-xs", data.isError ? "text-destructive" : "text-green-700 dark:text-green-500")}
          >
            {data.notice}
          </p>
        )}

        {/* Browsing a marketplace replaces the overview — it's its own screen. */}
        {catalog && <CatalogBrowser key={catalog.name} catalog={catalog} onBack={() => setBrowsing(undefined)} />}

        {showPlugins && !catalog && (<>
        <Section title="Claude plugins" count={overview.plugins.length}>
          {overview.plugins.length === 0 ? (
            <li className="px-1.5 py-1 text-[11px] text-muted-foreground">
              No plugins loaded. Add a marketplace below, or drop plugins into <span className="font-mono">~/.pizzapi/plugins/</span>.
            </li>
          ) : (
            overview.plugins.map((p) => <PluginRow key={p.key ?? p.name} plugin={p} />)
          )}
        </Section>

        {overview.disabled.length > 0 && (
          <Section title="Disabled" count={overview.disabled.length}>
            {overview.disabled.map((p) => (
              <li key={p.key} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/20">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {p.name}{p.marketplace && <span className="opacity-60">@{p.marketplace}</span>}
                </span>
                <ActionButton id={`enable:${p.key}`} args={["enable", p.key]} label="Enable" />
                {p.marketplace && <ActionButton id={`uninstall:${p.key}`} args={["uninstall", p.key]} label="Uninstall" confirm />}
              </li>
            ))}
          </Section>
        )}

        <Section title="Marketplaces" count={overview.marketplaces.length}>
          {overview.marketplaces.length === 0 && (
            <li className="px-1.5 py-1 text-[11px] text-muted-foreground">No marketplaces added.</li>
          )}
          {overview.marketplaces.map((m) => (
            <li key={m.name} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/20">
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="truncate font-mono text-xs text-foreground" title={m.source}>{m.name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{plural(m.pluginCount, "plugin")}</span>
              </span>
              <ActionButton id={`show:${m.name}`} args={["marketplace", "show", m.name]} label="Browse" />
              {m.source && <ActionButton id={`update:${m.name}`} args={["marketplace", "update", m.name]} label="Update" />}
              <ActionButton id={`remove:${m.name}`} args={["marketplace", "remove", m.name]} label="Remove" confirm />
            </li>
          ))}
          <SourceForm
            id="marketplace-add"
            label="Marketplace source"
            submitLabel="Add"
            placeholder="owner/repo, git URL, or path"
            toArgs={(source) => ["marketplace", "add", source]}
          />
        </Section>
        </>)}

        {showPackages && !catalog && (
          <Section
            title={showPlugins ? "Pi packages" : "Installed"}
            count={overview.packages.length}
            collapsible={showPlugins}
            defaultOpen={!showPlugins}
            action={overview.packages.length > 0
              ? <ActionButton id="pkg-update-all" args={["package", "update"]} label="Update all" />
              : undefined}
          >
            {overview.packages.length === 0 && (
              <li className="px-1.5 py-1 text-[11px] text-muted-foreground">No pi packages configured.</li>
            )}
            {overview.packages.map((p) => <PackageRow key={`${p.scope}:${p.source}`} pkg={p} />)}
            <SourceForm
              id="pkg-install"
              label="Pi package source"
              submitLabel="Install"
              placeholder="npm:@scope/pkg, git:github.com/user/repo, or path"
              localLabel={projectName ? `Project (${projectName})` : undefined}
              toArgs={(source, local) => ["package", "install", source, ...(local ? ["--local"] : [])]}
            />
          </Section>
        )}
        </div>
      </div>
    </ActionContext.Provider>
  );
}
