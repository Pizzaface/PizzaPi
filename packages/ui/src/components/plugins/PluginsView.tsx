/**
 * Shared Claude-plugin management view — rendered by the in-session `/plugin`
 * card and the runner panel's Plugins tab. Data is the structured result of a
 * `/plugin` run (see packages/cli/src/extensions/plugin-command.ts); every
 * action is expressed as `/plugin` args handed to `onCommand`. Without
 * `onCommand` the view is read-only.
 */
import * as React from "react";
import {
  AlertTriangle,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Loader2,
  Package,
  Puzzle,
  Server,
  Store,
  Terminal,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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
function ActionButton({ id, args, label, confirm, variant = "outline" }: {
  id: string;
  args: string[];
  label: string;
  confirm?: boolean;
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
      className="h-6 px-2 text-[11px]"
      disabled={ctx.pending !== null}
      onClick={(e) => {
        e.stopPropagation();
        if (confirm && !armed) { setArmed(true); return; }
        setArmed(false);
        ctx.run(id, args);
      }}
    >
      {busy && <Loader2 className="size-3 animate-spin" />}
      {armed ? `Confirm ${label.toLowerCase()}?` : label}
    </Button>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Section({ title, icon: Icon, count, children, action }: {
  title: string;
  icon: React.ElementType;
  count?: number;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="py-2">
      <div className="flex items-center justify-between px-3 pb-1.5">
        <h4 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Icon className="size-3" />
          {title}
          {count !== undefined && (
            <Badge variant="secondary" className="h-4 rounded-sm px-1.5 font-mono text-[10px]">{count}</Badge>
          )}
        </h4>
        {action}
      </div>
      <ul className="flex flex-col gap-1 px-2">{children}</ul>
    </section>
  );
}

function CapCount({ icon: Icon, n, label }: { icon: React.ElementType; n: number; label: string }) {
  if (n === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
      <Icon className="size-2.5" />
      {n} {label}{n === 1 ? "" : "s"}
    </span>
  );
}

function SourceBadge({ plugin }: { plugin: PluginInfo }) {
  const label = plugin.source === "marketplace"
    ? `@${plugin.marketplace ?? "marketplace"}`
    : plugin.source === "project" ? "project" : plugin.source === "directory" ? "local dir" : null;
  if (!label) return null;
  return (
    <Badge variant="outline" className="h-4 px-1 font-mono text-[9px]" title={plugin.rootPath}>{label}</Badge>
  );
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
      className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80 hover:bg-muted"
    >
      {text}
      {copied ? <Check className="size-2.5 text-green-500" /> : <Copy className="size-2.5 opacity-50" />}
    </button>
  );
}

function NameList({ label, icon: Icon, names }: { label: string; icon: React.ElementType; names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div>
      <p className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
        <Icon className="size-2.5" /> {label}
      </p>
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
  return (
    <li className="rounded-md border border-border/40 bg-muted/20">
      <div className="flex items-start gap-2 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} details for ${plugin.name}`}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <Puzzle className="mt-0.5 size-3.5 shrink-0 text-primary/60" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate font-mono text-xs font-semibold text-foreground">{plugin.name}</span>
              {plugin.version && <Badge variant="outline" className="h-4 px-1 font-mono text-[9px]">v{plugin.version}</Badge>}
              <SourceBadge plugin={plugin} />
              {plugin.author && <span className="text-[10px] text-muted-foreground">by {plugin.author}</span>}
            </div>
            {plugin.description && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{plugin.description}</p>}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <CapCount icon={Terminal} n={plugin.commands.length} label="cmd" />
              <CapCount icon={BookOpen} n={plugin.skills.length} label="skill" />
              <CapCount icon={Bot} n={plugin.agents?.length ?? 0} label="agent" />
              <CapCount icon={Zap} n={plugin.hookEvents.length} label="hook" />
              <CapCount icon={FileText} n={plugin.rules.length} label="rule" />
              {(plugin.hasMcp || plugin.hasLsp) && (
                <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500/80" title="Not adapted (Claude Code–only)">
                  <AlertTriangle className="size-2.5" />
                  {[plugin.hasMcp && "MCP", plugin.hasLsp && "LSP"].filter(Boolean).join(" + ")}
                </span>
              )}
            </div>
          </div>
          <ChevronDown className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
        <div className="flex shrink-0 gap-1">
          <ActionButton id={`disable:${key}`} args={["disable", key]} label="Disable" />
          {plugin.source === "marketplace" && (
            <ActionButton id={`uninstall:${key}`} args={["uninstall", key]} label="Uninstall" confirm />
          )}
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border/30 px-3 py-2">
          {plugin.commands.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                <Terminal className="size-2.5" /> Commands
              </p>
              <div className="flex flex-wrap gap-1">
                {plugin.commands.map((c) => (
                  <CopyChip key={c.name} text={`/${plugin.name}:${c.name}`} title={[c.argumentHint, c.description].filter(Boolean).join(" — ")} />
                ))}
              </div>
            </div>
          )}
          <NameList label="Skills" icon={BookOpen} names={plugin.skills.map((s) => s.name)} />
          <NameList label="Agents" icon={Bot} names={(plugin.agents ?? []).map((a) => a.name)} />
          <NameList
            label="Hooks"
            icon={Zap}
            names={plugin.hookEvents.map((e) => {
              const mapped = HOOK_EVENT_MAPPING[e];
              return mapped ? `${e} → ${mapped}` : `${e} (not adapted)`;
            })}
          />
          <NameList label="Rules" icon={FileText} names={plugin.rules.map((r) => r.name)} />
          <p className="truncate font-mono text-[10px] text-muted-foreground/70" title={plugin.rootPath}>{plugin.rootPath}</p>
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
      className="flex flex-wrap items-center gap-1.5 px-2 pt-1.5"
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
        className="h-7 min-w-0 flex-1 text-xs"
      />
      {localLabel && (
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title="Install into the project's .pizzapi/settings.json instead of your user settings">
          <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
          {localLabel}
        </label>
      )}
      <Button type="submit" size="sm" className="h-7 px-2.5 text-xs" disabled={!source || ctx.pending !== null}>
        {ctx.pending === id && <Loader2 className="size-3 animate-spin" />}
        {submitLabel}
      </Button>
    </form>
  );
}

function PackageRow({ pkg }: { pkg: PiPackageInfo }) {
  const scopeArgs = pkg.scope === "project" ? ["--local"] : [];
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/20">
      <Package className="size-3 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-mono text-xs text-foreground" title={pkg.source}>{pkg.source}</span>
          <Badge variant="outline" className="h-4 px-1 font-mono text-[9px]">{pkg.scope}</Badge>
          {pkg.filtered && (
            <Badge variant="outline" className="h-4 px-1 text-[9px]" title="Only some of this package's resources are enabled">filtered</Badge>
          )}
        </div>
        {pkg.installedPath && (
          <p className="truncate font-mono text-[10px] text-muted-foreground/70" title={pkg.installedPath}>{pkg.installedPath}</p>
        )}
      </div>
      <ActionButton id={`pkg-update:${pkg.scope}:${pkg.source}`} args={["package", "update", pkg.source]} label="Update" variant="ghost" />
      <ActionButton id={`pkg-remove:${pkg.scope}:${pkg.source}`} args={["package", "remove", pkg.source, ...scopeArgs]} label="Remove" confirm />
    </li>
  );
}

// ── Main view ────────────────────────────────────────────────────────────────

export type PluginsViewSection = "plugins" | "packages";

export function PluginsView({ data, onCommand, className, sections = ["plugins", "packages"] }: {
  data: PluginsViewData;
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
  const catalog = showPlugins ? data.catalog : undefined;
  const projectName = overview.packagesCwd?.split(/[\\/]/).filter(Boolean).pop();

  return (
    <ActionContext.Provider value={actions}>
      <div className={cn("divide-y divide-border/40", className)}>
        {data.notice && (
          <p
            role={data.isError ? "alert" : "status"}
            className={cn("whitespace-pre-wrap px-3 py-2 text-xs", data.isError ? "text-red-400" : "text-green-500")}
          >
            {data.notice}
          </p>
        )}

        {catalog && (
          <Section title={`Marketplace: ${catalog.name}`} icon={Store} count={catalog.plugins.length}>
            {catalog.description && <p className="px-1 pb-1 text-[11px] text-muted-foreground">{catalog.description}</p>}
            {catalog.plugins.map((p) => (
              <li key={p.key} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/20">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs text-foreground">{p.name}</span>
                    {p.category && <Badge variant="outline" className="h-4 px-1 text-[9px]">{p.category}</Badge>}
                  </div>
                  {p.description && <p className="line-clamp-2 text-[11px] text-muted-foreground">{p.description}</p>}
                </div>
                {!p.installed ? (
                  <ActionButton id={`install:${p.key}`} args={["install", p.key]} label="Install" variant="default" />
                ) : p.enabled ? (
                  <Badge variant="secondary" className="h-5 text-[10px]"><Check className="mr-0.5 size-2.5" />Installed</Badge>
                ) : (
                  <ActionButton id={`enable:${p.key}`} args={["enable", p.key]} label="Enable" />
                )}
              </li>
            ))}
          </Section>
        )}

        {showPlugins && (<>
        <Section title="Claude plugins" icon={Puzzle} count={overview.plugins.length}>
          {overview.plugins.length === 0 ? (
            <li className="px-1 py-1 text-[11px] text-muted-foreground">
              No plugins loaded. Add a marketplace below, or drop plugins into <span className="font-mono">~/.pizzapi/plugins/</span>.
            </li>
          ) : (
            overview.plugins.map((p) => <PluginRow key={p.key ?? p.name} plugin={p} />)
          )}
        </Section>

        {overview.disabled.length > 0 && (
          <Section title="Disabled" icon={Puzzle} count={overview.disabled.length}>
            {overview.disabled.map((p) => (
              <li key={p.key} className="flex items-center gap-2 rounded-md px-2 py-1.5 opacity-80">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {p.name}{p.marketplace && <span className="opacity-60">@{p.marketplace}</span>}
                </span>
                <ActionButton id={`enable:${p.key}`} args={["enable", p.key]} label="Enable" />
                {p.marketplace && <ActionButton id={`uninstall:${p.key}`} args={["uninstall", p.key]} label="Uninstall" confirm />}
              </li>
            ))}
          </Section>
        )}

        <Section title="Marketplaces" icon={Store} count={overview.marketplaces.length}>
          {overview.marketplaces.length === 0 && (
            <li className="px-1 py-1 text-[11px] text-muted-foreground">No marketplaces added.</li>
          )}
          {overview.marketplaces.map((m) => (
            <li key={m.name} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/20">
              <Server className="size-3 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <span className="font-mono text-xs text-foreground">{m.name}</span>
                <span className="ml-1.5 text-[10px] text-muted-foreground">{m.pluginCount} plugin{m.pluginCount === 1 ? "" : "s"}</span>
                {m.source && <p className="truncate font-mono text-[10px] text-muted-foreground/70" title={m.source}>{m.source}</p>}
              </div>
              <ActionButton id={`show:${m.name}`} args={["marketplace", "show", m.name]} label="Browse" variant="ghost" />
              {m.source && <ActionButton id={`update:${m.name}`} args={["marketplace", "add", m.source]} label="Update" variant="ghost" />}
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

        {showPackages && (
          <Section
            title="Pi packages"
            icon={Package}
            count={overview.packages.length}
            action={overview.packages.length > 0
              ? <ActionButton id="pkg-update-all" args={["package", "update"]} label="Update all" variant="ghost" />
              : undefined}
          >
            {overview.packages.length === 0 && (
              <li className="px-1 py-1 text-[11px] text-muted-foreground">No pi packages configured.</li>
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
    </ActionContext.Provider>
  );
}
