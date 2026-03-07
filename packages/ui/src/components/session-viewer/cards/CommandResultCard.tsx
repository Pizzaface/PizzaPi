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
} from "lucide-react";

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
  serverCount: number;
  servers: McpServerEntry[];
  errors: McpError[];
  loadedAt?: string;
}

// ── Plugins ───────────────────────────────────────────────────────────────────

export interface PluginEntry {
  name: string;
  description?: string;
  version?: string;
  commandCount: number;
  hookCount: number;
  skillCount: number;
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

function McpCard({ data }: { data: McpResultData }) {
  const [showTools, setShowTools] = React.useState(false);
  const hasErrors = data.errors.length > 0;

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
          <StatusPill variant={data.toolCount > 0 ? "success" : "neutral"}>
            {data.toolCount} tool{data.toolCount !== 1 ? "s" : ""}
          </StatusPill>
        </div>
      </ToolCardHeader>

      {/* Servers */}
      {data.servers.length > 0 && (
        <div className="border-b border-zinc-800/60 px-4 py-2.5">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1.5">
            Servers ({data.serverCount})
          </div>
          <div className="flex flex-col gap-1">
            {data.servers.map((s) => (
              <div key={`${s.name}-${s.scope}`} className="flex items-center gap-2">
                <Server className="size-3 shrink-0 text-zinc-500" />
                <span className="text-xs font-mono text-zinc-300 truncate">{s.name}</span>
                <Badge variant="outline" className="h-3.5 px-1 text-[9px] font-mono border-zinc-700 text-zinc-500">
                  {s.transport}
                </Badge>
                <span className="text-[10px] text-zinc-600 ml-auto">{s.scope}</span>
              </div>
            ))}
          </div>
        </div>
      )}

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

      {/* Tools (collapsible) */}
      {data.toolNames.length > 0 && (
        <div className="px-4 py-2">
          <button
            type="button"
            onClick={() => setShowTools(!showTools)}
            className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-400 transition-colors w-full"
          >
            <ChevronDown className={cn("size-3 transition-transform", showTools && "rotate-180")} />
            Tools ({data.toolNames.length})
          </button>
          {showTools && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {data.toolNames.map((name) => (
                <span key={name} className="inline-block rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">
                  {name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* No servers configured */}
      {data.servers.length === 0 && data.toolCount === 0 && !hasErrors && (
        <div className="px-4 py-3 text-xs text-zinc-500 text-center">
          No MCP servers configured.
        </div>
      )}
    </ToolCardShell>
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

  return (
    <ToolCardShell>
      <ToolCardHeader>
        <ToolCardTitle icon={<Puzzle className="size-4 shrink-0 text-zinc-400" />}>
          <span className="text-sm font-medium text-zinc-300">Plugins</span>
        </ToolCardTitle>
        <StatusPill variant="success">
          {data.plugins.length} loaded
        </StatusPill>
      </ToolCardHeader>
      <ul className="divide-y divide-zinc-800/60">
        {data.plugins.map((p) => (
          <li key={p.name} className="px-4 py-2.5 flex items-start gap-2.5">
            <Puzzle className="size-3.5 mt-0.5 shrink-0 text-zinc-500" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold font-mono text-zinc-200">{p.name}</span>
                {p.version && (
                  <Badge variant="outline" className="h-3.5 px-1 text-[9px] font-mono border-zinc-700 text-zinc-500">
                    v{p.version}
                  </Badge>
                )}
              </div>
              {p.description && (
                <p className="text-[11px] text-zinc-500 mt-0.5 line-clamp-2">{p.description}</p>
              )}
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {p.commandCount > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-500">
                    <Terminal className="size-2.5" />
                    {p.commandCount} cmd{p.commandCount > 1 ? "s" : ""}
                  </span>
                )}
                {p.hookCount > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-500">
                    <Zap className="size-2.5" />
                    {p.hookCount} hook{p.hookCount > 1 ? "s" : ""}
                  </span>
                )}
                {p.skillCount > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-500">
                    <BookOpen className="size-2.5" />
                    {p.skillCount} skill{p.skillCount > 1 ? "s" : ""}
                  </span>
                )}
                {p.hasMcp && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500/80">
                    <AlertTriangle className="size-2.5" />
                    MCP
                  </span>
                )}
                {p.hasAgents && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500/80">
                    <Bot className="size-2.5" />
                    Agents
                  </span>
                )}
              </div>
            </div>
          </li>
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
