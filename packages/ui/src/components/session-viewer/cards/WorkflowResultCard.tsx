/**
 * WorkflowResultCard — renders `run_workflow` / `run_saved_workflow` tool results,
 * mirroring the visual language of SubagentResultCard.
 *
 * The details payload shape is `WorkflowDetails`, defined in
 * `packages/cli/src/extensions/workflow/types.ts` — keep this local mirror in sync.
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ ⚡ Workflow: deploy   3 agents · ↑12k  ✅ Done │  ← header
 *   ├─────────────────────────────────────────────┤
 *   │ ▸ Phase 1: fetch                             │  ← collapsible phase
 *   │   ● agent-1  researcher  1.2k  ✅            │  ← agent row
 *   │ ▸ Phase 2: summarize                         │
 *   ├─────────────────────────────────────────────┤
 *   │ Error: ...                                   │  ← error banner (if any)
 *   └─────────────────────────────────────────────┘
 */

import * as React from "react";
import {
  ZapIcon,
  Loader2Icon,
  CheckCircle2Icon,
  XCircleIcon,
  ChevronRightIcon,
  CircleIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCardShell } from "@/components/ui/tool-card";

// ── Types (mirroring cli workflow/types.ts — keep in sync) ─────────────

const AGENT_STATUSES = ["pending", "running", "done", "error"] as const;
const WORKFLOW_STATUSES = ["running", "done", "error"] as const;

type WorkflowAgentStatus = (typeof AGENT_STATUSES)[number] | "unknown";
type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number] | "unknown";

interface WorkflowAgentInfo {
  id: string;
  label?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  model?: string;
  tokens?: number;
  result?: string;
  error?: string;
}

interface WorkflowPhase {
  label: string;
  agents: WorkflowAgentInfo[];
}

interface WorkflowDetails {
  name?: string;
  status: WorkflowStatus;
  phases: WorkflowPhase[];
  totalAgents: number;
  totalTokens: number;
  error?: string;
  result?: unknown;
}

// ── Validation (never crash on partial/malformed data) ──────────────────

/** Returns `value` if it's a string, otherwise `undefined` — guards every
 * optional field before it can reach truncate() or a React child slot. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Narrows an arbitrary value to one of `allowed`, else "unknown" — never
 * lets an unrecognized status string render as a valid state. */
function normalizeStatus<T extends string>(value: unknown, allowed: readonly T[]): T | "unknown" {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : "unknown";
}

function isValidAgent(a: unknown): a is Record<string, unknown> {
  if (!a || typeof a !== "object") return false;
  const obj = a as Record<string, unknown>;
  return typeof obj.id === "string" && typeof obj.prompt === "string";
}

/** Structural gate + coercion: required fields (id/prompt) must be strings;
 * every optional field is coerced to a safe string or dropped entirely. */
function sanitizeAgent(a: Record<string, unknown>): WorkflowAgentInfo {
  return {
    id: a.id as string,
    prompt: a.prompt as string,
    label: asString(a.label),
    status: normalizeStatus(a.status, AGENT_STATUSES),
    model: asString(a.model),
    tokens: typeof a.tokens === "number" ? a.tokens : undefined,
    result: asString(a.result),
    error: asString(a.error),
  };
}

function isValidPhase(p: unknown): p is Record<string, unknown> {
  if (!p || typeof p !== "object") return false;
  const obj = p as Record<string, unknown>;
  return Array.isArray(obj.agents) && obj.agents.every(isValidAgent);
}

function sanitizePhase(p: Record<string, unknown>): WorkflowPhase {
  return {
    label: asString(p.label) ?? "Untitled phase",
    agents: (p.agents as Record<string, unknown>[]).map(sanitizeAgent),
  };
}

function parseWorkflowDetails(details: unknown): WorkflowDetails | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const obj = details as Record<string, unknown>;
  if (!Array.isArray(obj.phases)) return null;
  if (!obj.phases.every(isValidPhase)) return null;
  return {
    name: asString(obj.name),
    status: normalizeStatus(obj.status, WORKFLOW_STATUSES),
    phases: (obj.phases as Record<string, unknown>[]).map(sanitizePhase),
    totalAgents: typeof obj.totalAgents === "number" ? obj.totalAgents : 0,
    totalTokens: typeof obj.totalTokens === "number" ? obj.totalTokens : 0,
    error: asString(obj.error),
    result: obj.result,
  };
}

/** Fallback: extract WorkflowDetails embedded in the tool result content
 * (streaming path, before the trusted top-level `details` prop arrives). */
function parseDetailsFromContent(content: unknown): WorkflowDetails | null {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    const parsed = parseWorkflowDetails(obj.details);
    if (parsed) return parsed;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      const parsed = parseWorkflowDetails(b.details);
      if (parsed) return parsed;
      if (b.type === "text" && typeof b.text === "string") {
        try {
          const fromText = parseWorkflowDetails(JSON.parse(b.text));
          if (fromText) return fromText;
        } catch {
          // not JSON
        }
      }
    }
  }
  return null;
}

// ── Formatting helpers ───────────────────────────────────────────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

// ── Status indicator sub-components ──────────────────────────────────────

function StatusIcon({ status }: { status: WorkflowAgentStatus }) {
  switch (status) {
    case "running":
      return <Loader2Icon className="size-3 shrink-0 animate-spin text-violet-400" />;
    case "done":
      return <CheckCircle2Icon className="size-3 shrink-0 text-emerald-500" />;
    case "error":
      return <XCircleIcon className="size-3 shrink-0 text-red-400" />;
    default:
      return <CircleIcon className="size-3 shrink-0 text-zinc-600" />;
  }
}

function StatusPillFor({ status }: { status: WorkflowStatus }) {
  if (status === "running") {
    return (
      <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-violet-400 shrink-0">
        <Loader2Icon className="size-2.5 animate-spin" />
        Running
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-red-400 shrink-0">
        <XCircleIcon className="size-3" />
        Failed
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-emerald-400 shrink-0">
        <CheckCircle2Icon className="size-3" />
        Done
      </span>
    );
  }
  return (
    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-zinc-500 shrink-0">
      <CircleIcon className="size-3" />
      Unknown
    </span>
  );
}

// ── Agent row ─────────────────────────────────────────────────────────────

function AgentRow({ agent }: { agent: WorkflowAgentInfo }) {
  const [expanded, setExpanded] = React.useState(false);
  const detail = agent.status === "error" ? agent.error : agent.result;
  const hasDetail = typeof detail === "string" && detail.length > 0;
  const rowContent = (
    <>
      {hasDetail ? (
        <ChevronRightIcon
          className={cn("size-3 shrink-0 text-zinc-500 transition-transform", expanded && "rotate-90")}
        />
      ) : (
        <span className="size-3 shrink-0" />
      )}
      <StatusIcon status={agent.status} />
      <span className="text-[0.75rem] text-zinc-300 truncate flex-1">
        {truncate(agent.label || agent.prompt || agent.id, 80)}
      </span>
      {agent.model && <span className="text-[10px] font-mono text-zinc-500 shrink-0">{agent.model}</span>}
      {typeof agent.tokens === "number" && agent.tokens > 0 && (
        <span className="text-[10px] font-mono text-zinc-600 shrink-0">{formatTokens(agent.tokens)}</span>
      )}
    </>
  );

  return (
    <div className="border-t border-zinc-800/60 first:border-t-0">
      {hasDetail ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-900/60 transition-colors"
        >
          {rowContent}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 px-3 py-1.5 text-left">{rowContent}</div>
      )}
      {expanded && hasDetail && (
        <div
          className={cn(
            "px-3 pb-2 pl-8 text-[0.75rem] whitespace-pre-wrap break-words leading-relaxed",
            agent.status === "error" ? "text-red-300" : "text-zinc-400",
          )}
        >
          {detail}
        </div>
      )}
    </div>
  );
}

// ── Phase section ─────────────────────────────────────────────────────────

function PhaseSection({ phase, defaultOpen }: { phase: WorkflowPhase; defaultOpen: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const done = phase.agents.filter((a) => a.status === "done").length;
  const errored = phase.agents.filter((a) => a.status === "error").length;

  return (
    <div className="border-t border-zinc-800/60 first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 hover:bg-zinc-900/40 transition-colors text-left"
      >
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-zinc-500 transition-transform", open && "rotate-90")} />
        <span className="text-[0.8rem] font-medium text-zinc-300 flex-1 truncate">{phase.label}</span>
        <span className="text-[10px] text-zinc-600 shrink-0">
          {errored > 0 ? `${done}/${phase.agents.length} · ${errored} failed` : `${done}/${phase.agents.length}`}
        </span>
      </button>
      {open && (
        <div className="pb-1">
          {phase.agents.length === 0 ? (
            <div className="px-3 py-1.5 pl-8 text-[0.75rem] text-zinc-600">No agents yet</div>
          ) : (
            phase.agents.map((agent) => <AgentRow key={agent.id} agent={agent} />)
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────

export function WorkflowResultCard({
  details: detailsProp,
  content,
}: {
  details?: unknown;
  content?: unknown;
}) {
  // Prefer the trusted top-level details prop (from the final tool result
  // message) over content-embedded details (streaming path).
  const workflow = parseWorkflowDetails(detailsProp) ?? parseDetailsFromContent(content);

  if (!workflow) {
    // No usable details yet — e.g. still streaming before the first update.
    return (
      <ToolCardShell className="border-zinc-700/80">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
          <ZapIcon className="size-3.5 shrink-0 text-violet-400" />
          <span className="text-[0.8rem] font-semibold text-zinc-300">Workflow</span>
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-violet-400 shrink-0">
            <Loader2Icon className="size-2.5 animate-spin" />
            Starting…
          </span>
        </div>
      </ToolCardShell>
    );
  }

  const { name, status, phases, totalAgents, totalTokens, error } = workflow;

  return (
    <ToolCardShell className="border-zinc-700/80">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <ZapIcon className="size-3.5 shrink-0 text-violet-400" />
        <span className="text-[0.8rem] font-semibold text-zinc-300">
          Workflow{name ? `: ${name}` : ""}
        </span>
        {totalAgents > 0 && (
          <span className="text-[10px] font-mono text-zinc-500 shrink-0">
            {totalAgents} agent{totalAgents !== 1 ? "s" : ""}
          </span>
        )}
        {totalTokens > 0 && (
          <span className="text-[10px] font-mono text-zinc-600 shrink-0">↑{formatTokens(totalTokens)}</span>
        )}
        <StatusPillFor status={status} />
      </div>

      {/* Phases */}
      {phases.length === 0 ? (
        <div className="px-3 py-3 text-[0.75rem] text-zinc-600">No phases yet</div>
      ) : (
        <div className="flex flex-col max-h-[32rem] overflow-y-auto">
          {phases.map((phase, i) => (
            <PhaseSection key={`${phase.label}-${i}`} phase={phase} defaultOpen={phases.length <= 3} />
          ))}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="border-t border-zinc-800 px-3 py-2 text-[0.75rem] text-red-300 whitespace-pre-wrap break-words">
          {error}
        </div>
      )}
    </ToolCardShell>
  );
}
