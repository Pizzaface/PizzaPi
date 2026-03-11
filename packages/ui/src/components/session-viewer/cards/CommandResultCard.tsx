import * as React from "react";
import {
  ToolCardShell,
  ToolCardHeader,
  ToolCardTitle,
  StatusPill,
} from "@/components/ui/tool-card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Server,
  Puzzle,
  BookOpen,
  Terminal,
  Zap,
  AlertTriangle,
  Bot,
  FileText,
  ChevronDown,
  RefreshCw,
  Eye,
  EyeOff,
} from "lucide-react";
import { useMcpToggle } from "@/components/session-viewer/McpToggleContext";

// ── Shared types ──────────────────────────────────────────────────────────────

/** Discriminated union for structured command results rendered as cards. */
export type CommandResultData =
  | McpResultData
  | PluginsResultData
  | SkillsResultData;

// ── MCP ───────────────────────────────────────────────────────────────────────

export interface McpServerEntry {
  name: string;
  transport: string;
  scope: string;
  sourcePath?: string;
}

export interface McpError {
  server: string;
  error: string;
}

export interface McpResultData {
  kind: "mcp";
  action: "status" | "reload";
  toolCount: number;
  toolNames: string[];
  /** Tools grouped by MCP server name */
  serverTools: Record<string, string[]>;
  serverCount: number;
  servers: McpServerEntry[];
  errors: McpError[];
  loadedAt?: string;
  /** Server names currently disabled via config */
  disabledServers?: string[];
}

// ── Plugins ───────────────────────────────────────────────────────────────────

export interface PluginCommandEntry {
  name: string;
  description?: string;
}

export interface PluginEntry {
  name: string;
  description?: string;
  version?: string;
  commands: PluginCommandEntry[];
  hookCount: number;
  skillCount: number;
  ruleCount: number;
  hasMcp?: boolean;
  hasAgents?: boolean;
}

export interface PluginsResultData {
  kind: "plugins";
  plugins: PluginEntry[];
}

// ── Skills ────────────────────────────────────────────────────────────────────

export interface SkillEntry {
  name: string;
  description?: string;
}

export interface SkillsResultData {
  kind: "skills";
  skills: SkillEntry[];
}

// ── Card Renderers ────────────────────────────────────────────────────────────

/** Collapsible per-server tool group */
function ServerToolGroup({ serverName, tools, transport, scope, defaultOpen, disabled, onToggle }: {
  serverName: string;
  tools: string[];
  transport?: string;
  scope?: string;
  defaultOpen: boolean;
  /** Whether this server is currently disabled */
  disabled?: boolean;
  /** Callback to toggle enabled/disabled state */
  onToggle?: (serverName: string, disabled: boolean) => void;
}) {
  const [open, setOpen] = React.useState(defaultOpen && !disabled);

  return (
    <div className={cn("border-b border-zinc-800/60 last:border-b-0", disabled && "opacity-50")}>
      <div className="flex items-center gap-0 w-full">
        <button
          type="button"
          onClick={() => !disabled && setOpen(!open)}
          className={cn(
            "flex items-center gap-2 flex-1 min-w-0 px-4 py-2 text-left transition-colors",
            !disabled && "hover:bg-zinc-900/50",
            disabled && "cursor-default",
          )}
        >
          {!disabled && (
            <ChevronDown className={cn("size-3 shrink-0 text-zinc-500 transition-transform", open && "rotate-180")} />
          )}
          <Server className="size-3 shrink-0 text-zinc-500" />
          <span className={cn("text-xs font-mono font-medium truncate", disabled ? "text-zinc-500 line-through decoration-zinc-600" : "text-zinc-300")}>
            {serverName}
          </span>
          {transport && (
            <Badge variant="outline" className="h-3.5 px-1 text-[9px] font-mono border-zinc-700 text-zinc-500">
              {transport}
            </Badge>
          )}
          {disabled ? (
            <span className="text-[10px] text-zinc-600 tabular-nums ml-auto shrink-0">disabled</span>
          ) : (
            <span className="text-[10px] text-zinc-600 tabular-nums ml-auto shrink-0">
              {tools.length} tool{tools.length !== 1 ? "s" : ""}
              {scope && <span className="ml-1.5 text-zinc-600/70">{scope}</span>}
            </span>
          )}
        </button>
        {onToggle && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggle(serverName, !disabled); }}
            className="flex-shrink-0 p-2 hover:bg-zinc-900/50 transition-colors rounded-r"
            title={disabled ? `Enable ${serverName}` : `Disable ${serverName}`}
          >
            {disabled ? (
              <EyeOff className="size-3.5 text-zinc-600 hover:text-zinc-400 transition-colors" />
            ) : (
              <Eye className="size-3.5 text-zinc-500 hover:text-zinc-300 transition-colors" />
            )}
          </button>
        )}
      </div>
      {open && !disabled && tools.length > 0 && (
        <div className="px-4 pb-2.5 pt-0.5 flex flex-wrap gap-1">
          {tools.map((name) => (
            <span key={name} className="inline-block rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function McpCard({ data }: { data: McpResultData }) {
  const hasErrors = data.errors.length > 0;
  const hasServerTools = Object.keys(data.serverTools ?? {}).length > 0;
  const disabledSet = React.useMemo(() => new Set(data.disabledServers ?? []), [data.disabledServers]);
  const mcpToggle = useMcpToggle();

  // Build a lookup from server name → config entry for transport/scope info
  const serverConfigMap = React.useMemo(() => {
    const map = new Map<string, McpServerEntry>();
    for (const s of data.servers) map.set(s.name, s);
    return map;
  }, [data.servers]);

  // Disabled servers that aren't already shown in serverTools (they were skipped)
  const disabledOnlyServers = React.useMemo(() => {
    return [...disabledSet].filter((name) => !data.serverTools[name]);
  }, [disabledSet, data.serverTools]);

  const disabledCount = disabledSet.size;

  return (
    <ToolCardShell>
      <ToolCardHeader>
        <ToolCardTitle icon={<Server className="size-4 shrink-0 text-zinc-400" />}>
          <span className="text-sm font-medium text-zinc-300">MCP Status</span>
          {data.action === "reload" && (
            <Badge variant="outline" className="ml-1.5 h-4 px-1.5 text-[9px] font-mono border-emerald-700/50 text-emerald-400">
              <RefreshCw className="size-2 mr-0.5" />
              reloaded
            </Badge>
          )}
        </ToolCardTitle>
        <div className="flex items-center gap-1.5">
          {hasErrors && (
            <StatusPill variant="error">
              {data.errors.length} error{data.errors.length > 1 ? "s" : ""}
            </StatusPill>
          )}
          {disabledCount > 0 && (
            <StatusPill variant="neutral">
              {disabledCount} disabled
            </StatusPill>
          )}
          <StatusPill variant={data.toolCount > 0 ? "success" : "neutral"}>
            {data.toolCount} tool{data.toolCount !== 1 ? "s" : ""}
          </StatusPill>
        </div>
      </ToolCardHeader>

      {/* Errors */}
      {hasErrors && (
        <div className="border-b border-zinc-800/60 px-4 py-2.5">
          <div className="text-[10px] uppercase tracking-wide text-red-400/80 mb-1.5 flex items-center gap-1">
            <AlertTriangle className="size-3" />
            Errors
          </div>
          <div className="flex flex-col gap-1">
            {data.errors.map((e, i) => (
              <div key={i} className="text-xs text-red-400/80 flex items-start gap-1.5">
                <span className="font-mono text-zinc-400 shrink-0">{e.server}:</span>
                <span className="break-words">{e.error}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tools grouped by server (active servers) */}
      {hasServerTools && (
        Object.entries(data.serverTools).map(([serverName, tools]) => {
          const config = serverConfigMap.get(serverName);
          return (
            <ServerToolGroup
              key={serverName}
              serverName={serverName}
              tools={tools}
              transport={config?.transport}
              scope={config?.scope}
              defaultOpen={Object.keys(data.serverTools).length <= 3}
              disabled={disabledSet.has(serverName)}
              onToggle={mcpToggle ?? undefined}
            />
          );
        })
      )}

      {/* Disabled servers that weren't in serverTools (skipped during init) */}
      {disabledOnlyServers.map((name) => {
        const config = serverConfigMap.get(name);
        return (
          <ServerToolGroup
            key={name}
            serverName={name}
            tools={[]}
            transport={config?.transport}
            scope={config?.scope}
            defaultOpen={false}
            disabled={true}
            onToggle={mcpToggle ?? undefined}
          />
        );
      })}

      {/* Fallback: flat tool list if no serverTools grouping available (old CLI) */}
      {!hasServerTools && data.toolNames.length > 0 && (
        <FlatToolList toolNames={data.toolNames} />
      )}

      {/* No servers configured */}
      {data.servers.length === 0 && data.toolCount === 0 && !hasErrors && disabledCount === 0 && (
        <div className="px-4 py-3 text-xs text-zinc-500 text-center">
          No MCP servers configured.
        </div>
      )}
    </ToolCardShell>
  );
}

/** Fallback flat tool list for backwards compat with older CLI that doesn't send serverTools */
function FlatToolList({ toolNames }: { toolNames: string[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="px-4 py-2 border-b border-zinc-800/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-400 transition-colors w-full"
      >
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
        Tools ({toolNames.length})
      </button>
      {open && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {toolNames.map((name) => (
            <span key={name} className="inline-block rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Collapsible plugin row that expands to show commands */
function PluginEntryRow({ plugin }: { plugin: PluginEntry }) {
  const [open, setOpen] = React.useState(false);
  const commandCount = plugin.commands.length;

  return (
    <li className="border-b border-zinc-800/60 last:border-b-0">
      <button
        type="button"
        onClick={() => commandCount > 0 && setOpen(!open)}
        className={cn(
          "flex items-start gap-2.5 w-full text-left px-4 py-2.5 transition-colors",
          commandCount > 0 && "hover:bg-zinc-900/50 cursor-pointer",
        )}
      >
        {commandCount > 0 ? (
          <ChevronDown className={cn("size-3 mt-0.5 shrink-0 text-zinc-500 transition-transform", open && "rotate-180")} />
        ) : (
          <Puzzle className="size-3.5 mt-0.5 shrink-0 text-zinc-500" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold font-mono text-zinc-200">{plugin.name}</span>
            {plugin.version && (
              <Badge variant="outline" className="h-3.5 px-1 text-[9px] font-mono border-zinc-700 text-zinc-500">
                v{plugin.version}
              </Badge>
            )}
          </div>
          {plugin.description && (
            <p className="text-[11px] text-zinc-500 mt-0.5 line-clamp-2">{plugin.description}</p>
          )}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {commandCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-500">
                <Terminal className="size-2.5" />
                {commandCount} cmd{commandCount > 1 ? "s" : ""}
              </span>
            )}
            {plugin.hookCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-500">
                <Zap className="size-2.5" />
                {plugin.hookCount} hook{plugin.hookCount > 1 ? "s" : ""}
              </span>
            )}
            {plugin.skillCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-500">
                <BookOpen className="size-2.5" />
                {plugin.skillCount} skill{plugin.skillCount > 1 ? "s" : ""}
              </span>
            )}
            {(plugin.ruleCount ?? 0) > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-500">
                <FileText className="size-2.5" />
                {plugin.ruleCount} rule{plugin.ruleCount > 1 ? "s" : ""}
              </span>
            )}
            {plugin.hasMcp && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500/80">
                <AlertTriangle className="size-2.5" />
                MCP
              </span>
            )}
            {plugin.hasAgents && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500/80">
                <Bot className="size-2.5" />
                Agents
              </span>
            )}
          </div>
        </div>
      </button>
      {open && commandCount > 0 && (
        <div className="px-4 pb-2.5 pt-0.5 flex flex-wrap gap-1">
          {plugin.commands.map((cmd) => (
            <span
              key={cmd.name}
              className="inline-flex items-center rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400"
              title={cmd.description}
            >
              /{plugin.name}:{cmd.name}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

function PluginsCard({ data }: { data: PluginsResultData }) {
  if (data.plugins.length === 0) {
    return (
      <ToolCardShell>
        <ToolCardHeader>
          <ToolCardTitle icon={<Puzzle className="size-4 shrink-0 text-zinc-400" />}>
            <span className="text-sm font-medium text-zinc-300">Plugins</span>
          </ToolCardTitle>
          <StatusPill variant="neutral">0</StatusPill>
        </ToolCardHeader>
        <div className="px-4 py-3 text-xs text-zinc-500 text-center">
          No plugins loaded.
        </div>
      </ToolCardShell>
    );
  }

  const totalCommands = data.plugins.reduce((sum, p) => sum + p.commands.length, 0);

  return (
    <ToolCardShell>
      <ToolCardHeader>
        <ToolCardTitle icon={<Puzzle className="size-4 shrink-0 text-zinc-400" />}>
          <span className="text-sm font-medium text-zinc-300">Plugins</span>
        </ToolCardTitle>
        <div className="flex items-center gap-1.5">
          <StatusPill variant="success">
            {data.plugins.length} loaded
          </StatusPill>
          {totalCommands > 0 && (
            <StatusPill variant="neutral">
              {totalCommands} cmd{totalCommands !== 1 ? "s" : ""}
            </StatusPill>
          )}
        </div>
      </ToolCardHeader>
      <ul>
        {data.plugins.map((p) => (
          <PluginEntryRow key={p.name} plugin={p} />
        ))}
      </ul>
    </ToolCardShell>
  );
}

function SkillsCard({ data }: { data: SkillsResultData }) {
  if (data.skills.length === 0) {
    return (
      <ToolCardShell>
        <ToolCardHeader>
          <ToolCardTitle icon={<BookOpen className="size-4 shrink-0 text-zinc-400" />}>
            <span className="text-sm font-medium text-zinc-300">Skills</span>
          </ToolCardTitle>
          <StatusPill variant="neutral">0</StatusPill>
        </ToolCardHeader>
        <div className="px-4 py-3 text-xs text-zinc-500 text-center">
          No skills available.
        </div>
      </ToolCardShell>
    );
  }

  return (
    <ToolCardShell>
      <ToolCardHeader>
        <ToolCardTitle icon={<BookOpen className="size-4 shrink-0 text-zinc-400" />}>
          <span className="text-sm font-medium text-zinc-300">Skills</span>
        </ToolCardTitle>
        <StatusPill variant="success">
          {data.skills.length} available
        </StatusPill>
      </ToolCardHeader>
      <ul className="divide-y divide-zinc-800/60">
        {data.skills.map((s) => (
          <li key={s.name} className="px-4 py-2 flex items-start gap-2.5">
            <BookOpen className="size-3.5 mt-0.5 shrink-0 text-zinc-500" />
            <div className="min-w-0 flex-1">
              <span className="text-xs font-semibold font-mono text-zinc-200">
                /{s.name.startsWith("skill:") ? s.name : `skill:${s.name}`}
              </span>
              {s.description && (
                <p className="text-[11px] text-zinc-500 mt-0.5">{s.description}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </ToolCardShell>
  );
}

// ── Main Card ─────────────────────────────────────────────────────────────────

export function CommandResultCard({ data }: { data: CommandResultData }) {
  switch (data.kind) {
    case "mcp":
      return <McpCard data={data} />;
    case "plugins":
      return <PluginsCard data={data} />;
    case "skills":
      return <SkillsCard data={data} />;
    default:
      return null;
  }
}
