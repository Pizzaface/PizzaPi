/**
 * SubagentResultCard — renders inline subagent tool results in the session viewer.
 *
 * Reads the structured `details` payload from the subagent tool result and renders
 * collapsed/expanded/streaming views for single, parallel, and chain modes.
 *
 * The details payload shape (defined in packages/cli/src/extensions/subagent.ts):
 *   interface SubagentDetails {
 *     mode: "single" | "parallel" | "chain";
 *     agentScope: "user" | "project" | "both";
 *     projectAgentsDir: string | null;
 *     results: SingleResult[];
 *   }
 */

import * as React from "react";
import {
  BotIcon,
  Loader2Icon,
  CheckCircle2Icon,
  XCircleIcon,
  ChevronDownIcon,
  ZapIcon,
  LinkIcon,
} from "lucide-react";
import {
  ToolCardShell,
  ToolCardHeader,
  ToolCardTitle,
  ToolCardActions,
  ToolCardSection,
  StatusPill,
} from "@/components/ui/tool-card";
import { MessageResponse } from "@/components/ai-elements/message";
import { CopyableCodeBlock } from "@/components/session-viewer/cards/InterAgentCards";
import { extractTextFromToolContent, parseToolInputArgs } from "@/components/session-viewer/utils";

// ── Types (mirroring CLI extension types) ──────────────────────────────

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Array<{ role: string; content: unknown[] }>;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: "user" | "project" | "both";
  projectAgentsDir: string | null;
  results: SingleResult[];
}

// ── Formatting helpers ─────────────────────────────────────────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function aggregateUsage(results: SingleResult[]): UsageStats {
  const total: UsageStats = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    cost: 0, contextTokens: 0, turns: 0,
  };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.contextTokens += r.usage.contextTokens;
    total.turns += r.usage.turns;
  }
  return total;
}

// ── Extract data from messages ─────────────────────────────────────────

function getFinalOutput(messages: Array<{ role: string; content: unknown[] }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part && typeof part === "object" && "type" in part && (part as any).type === "text") {
          return (part as any).text;
        }
      }
    }
  }
  return "";
}

interface ToolCallItem {
  name: string;
  args: Record<string, unknown>;
}

function getToolCalls(messages: Array<{ role: string; content: unknown[] }>): ToolCallItem[] {
  const items: ToolCallItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part && typeof part === "object" && "type" in part && (part as any).type === "toolCall") {
          items.push({ name: (part as any).name, args: (part as any).arguments ?? {} });
        }
      }
    }
  }
  return items;
}

function formatToolCallOneLiner(tc: ToolCallItem): string {
  const args = tc.args;
  switch (tc.name) {
    case "bash": {
      const cmd = typeof args.command === "string" ? args.command : "";
      return `$ ${cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd}`;
    }
    case "read": {
      const p = (args.file_path || args.path || "…") as string;
      return `read ${p}`;
    }
    case "write": {
      const p = (args.file_path || args.path || "…") as string;
      return `write ${p}`;
    }
    case "edit": {
      const p = (args.file_path || args.path || "…") as string;
      return `edit ${p}`;
    }
    default: {
      const s = JSON.stringify(args);
      return `${tc.name} ${s.length > 40 ? s.slice(0, 40) + "…" : s}`;
    }
  }
}

// ── Parse details from tool result ─────────────────────────────────────

function parseDetails(content: unknown): SubagentDetails | null {
  // The details are embedded in the tool result — try multiple approaches
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    if (obj.details && typeof obj.details === "object") {
      const d = obj.details as SubagentDetails;
      if (d.mode && d.results) return d;
    }
  }

  // Try extracting from array content blocks
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        // Check if block is a text block with JSON details
        if (b.type === "text" && typeof b.text === "string") {
          try {
            const parsed = JSON.parse(b.text);
            if (parsed.mode && parsed.results) return parsed;
          } catch {
            // not JSON
          }
        }
      }
    }
  }

  return null;
}

// ── Sub-components ─────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string }) {
  return (
    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">
      {source}
    </span>
  );
}

function UsageBar({ usage, model }: { usage: UsageStats; model?: string }) {
  const text = formatUsage(usage, model);
  if (!text) return null;
  return (
    <div className="px-4 py-1.5 text-[10px] font-mono text-zinc-500 border-b border-zinc-800/60">
      {text}
    </div>
  );
}

function StatusIcon({ exitCode, isRunning }: { exitCode: number; isRunning?: boolean }) {
  if (isRunning) return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-amber-400" />;
  if (exitCode === 0) return <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-400" />;
  return <XCircleIcon className="size-3.5 shrink-0 text-red-400" />;
}

function ToolCallTrace({ toolCalls }: { toolCalls: ToolCallItem[] }) {
  if (toolCalls.length === 0) return null;
  const MAX_SHOW = 8;
  const toShow = toolCalls.slice(0, MAX_SHOW);
  const remaining = toolCalls.length - MAX_SHOW;

  return (
    <div className="space-y-0.5 px-4 py-2 border-b border-zinc-800/60">
      <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-600 mb-1">
        Tool calls ({toolCalls.length})
      </div>
      {toShow.map((tc, i) => (
        <div key={i} className="text-[11px] font-mono text-zinc-400 truncate">
          <span className="text-zinc-600 mr-1">→</span>
          {formatToolCallOneLiner(tc)}
        </div>
      ))}
      {remaining > 0 && (
        <div className="text-[10px] text-zinc-600">… +{remaining} more</div>
      )}
    </div>
  );
}

function SingleResultCard({ result, expanded }: { result: SingleResult; expanded?: boolean }) {
  const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
  const isRunning = result.exitCode === -1;
  const finalOutput = getFinalOutput(result.messages);
  const toolCalls = getToolCalls(result.messages);
  const [isOpen, setIsOpen] = React.useState(expanded ?? false);

  return (
    <div className="border border-zinc-800/80 rounded-md overflow-hidden bg-zinc-950/50">
      {/* Header — always visible */}
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-900/50 transition-colors cursor-pointer"
        onClick={() => setIsOpen(!isOpen)}
      >
        <StatusIcon exitCode={result.exitCode} isRunning={isRunning} />
        <span className="text-xs font-medium text-zinc-300 truncate">{result.agent}</span>
        <SourceBadge source={result.agentSource} />
        {result.step !== undefined && (
          <span className="text-[10px] text-zinc-500">Step {result.step}</span>
        )}
        {isError && result.stopReason && (
          <span className="text-[10px] text-red-400">[{result.stopReason}]</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {result.model && (
            <span className="text-[10px] font-mono text-zinc-600 hidden sm:inline">{result.model}</span>
          )}
          <ChevronDownIcon
            className={`size-3 text-zinc-600 transition-transform ${isOpen ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      {/* Expanded content */}
      {isOpen && (
        <div className="border-t border-zinc-800/60">
          {/* Task */}
          <div className="px-3 py-2 border-b border-zinc-800/60">
            <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-600 mb-0.5">Task</div>
            <p className="text-[11px] text-zinc-400 whitespace-pre-wrap break-words line-clamp-4">
              {result.task}
            </p>
          </div>

          {/* Error message */}
          {isError && result.errorMessage && (
            <div className="px-3 py-2 border-b border-zinc-800/60 bg-red-950/20">
              <span className="text-[11px] text-red-400">{result.errorMessage}</span>
            </div>
          )}

          {/* Stderr excerpt */}
          {isError && result.stderr && (
            <div className="px-3 py-2 border-b border-zinc-800/60">
              <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-600 mb-0.5">Stderr</div>
              <pre className="text-[10px] font-mono text-red-300/70 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
                {result.stderr.slice(0, 500)}{result.stderr.length > 500 ? "…" : ""}
              </pre>
            </div>
          )}

          {/* Tool call trace */}
          {toolCalls.length > 0 && <ToolCallTrace toolCalls={toolCalls} />}

          {/* Final output */}
          {finalOutput && (
            <div className="px-3 py-2 border-b border-zinc-800/60">
              <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-600 mb-1">Output</div>
              <div className="prose prose-invert prose-xs max-w-none">
                <MessageResponse>{finalOutput}</MessageResponse>
              </div>
            </div>
          )}

          {/* Usage */}
          {result.usage.turns > 0 && (
            <div className="px-3 py-1.5 text-[10px] font-mono text-zinc-500">
              {formatUsage(result.usage, result.model)}
            </div>
          )}
        </div>
      )}

      {/* Collapsed preview — show brief output when not expanded */}
      {!isOpen && !isRunning && (
        <div className="px-3 py-1.5 border-t border-zinc-800/60">
          {finalOutput ? (
            <p className="text-[11px] text-zinc-500 truncate">{finalOutput.slice(0, 100)}</p>
          ) : isError ? (
            <p className="text-[11px] text-red-400/70 truncate">
              {result.errorMessage || result.stderr?.slice(0, 80) || "Failed"}
            </p>
          ) : (
            <p className="text-[11px] text-zinc-600 italic">No output</p>
          )}
        </div>
      )}

      {/* Running indicator */}
      {!isOpen && isRunning && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-zinc-800/60 text-[11px] text-amber-400/70">
          <Loader2Icon className="size-2.5 animate-spin" />
          Running…
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────

export function SubagentResultCard({
  toolInput,
  content,
  isStreaming,
  isError: isErrorProp,
}: {
  toolInput: unknown;
  content: unknown;
  isStreaming: boolean;
  isError?: boolean;
}) {
  const inputArgs = parseToolInputArgs(toolInput);
  const details = parseDetails(content);
  const resultText = extractTextFromToolContent(content);

  // Determine mode from input args
  const mode: "single" | "parallel" | "chain" =
    details?.mode ??
    (inputArgs.chain ? "chain" : inputArgs.tasks ? "parallel" : "single");

  const agentName = typeof inputArgs.agent === "string" ? inputArgs.agent : undefined;
  const taskPreview = typeof inputArgs.task === "string"
    ? (inputArgs.task.length > 80 ? inputArgs.task.slice(0, 77) + "…" : inputArgs.task)
    : undefined;

  // If we have no details, render a simple card
  if (!details || details.results.length === 0) {
    const hasError = isErrorProp || (resultText && resultText.startsWith("Error"));
    return (
      <ToolCardShell>
        <ToolCardHeader className="py-2.5">
          <ToolCardTitle icon={<BotIcon className="size-3.5 shrink-0 text-violet-400" />}>
            <span className="text-sm font-medium text-zinc-300">
              Subagent{agentName ? `: ${agentName}` : ""}
            </span>
          </ToolCardTitle>
          <ToolCardActions>
            {isStreaming ? (
              <StatusPill variant="streaming">Running…</StatusPill>
            ) : hasError ? (
              <StatusPill variant="error">Failed</StatusPill>
            ) : resultText ? (
              <StatusPill variant="success">Done</StatusPill>
            ) : null}
          </ToolCardActions>
        </ToolCardHeader>
        {taskPreview && (
          <ToolCardSection>
            <p className="text-[11px] text-zinc-400 truncate">{taskPreview}</p>
          </ToolCardSection>
        )}
        {resultText && (
          <ToolCardSection className="border-b-0">
            <MessageResponse>{resultText}</MessageResponse>
          </ToolCardSection>
        )}
      </ToolCardShell>
    );
  }

  // ── Compute status ─────────────────────────────────────────────────
  const results = details.results;
  const running = results.filter((r) => r.exitCode === -1).length;
  const succeeded = results.filter((r) => r.exitCode === 0).length;
  const failed = results.filter((r) => r.exitCode > 0).length;
  const isRunning = running > 0 || isStreaming;
  const totalUsage = aggregateUsage(results);

  // Mode icon and label
  const modeIcon = mode === "chain"
    ? <LinkIcon className="size-3.5 shrink-0 text-violet-400" />
    : mode === "parallel"
      ? <ZapIcon className="size-3.5 shrink-0 text-violet-400" />
      : <BotIcon className="size-3.5 shrink-0 text-violet-400" />;

  const modeLabel = mode === "single"
    ? `Subagent: ${results[0]?.agent ?? "unknown"}`
    : mode === "parallel"
      ? `Subagent: parallel (${results.length} tasks)`
      : `Subagent: chain (${results.length} steps)`;

  const statusPill = isRunning ? (
    <StatusPill variant="streaming">
      {running > 0 ? `${succeeded + failed}/${results.length} done` : "Running…"}
    </StatusPill>
  ) : failed > 0 ? (
    <StatusPill variant="error">
      {mode === "single" ? "Failed" : `${succeeded}/${results.length} passed`}
    </StatusPill>
  ) : (
    <StatusPill variant="success">
      {mode === "single" ? "Done" : `${succeeded}/${results.length} passed`}
    </StatusPill>
  );

  // ── Single mode: expand directly ─────────────────────────────────
  if (mode === "single" && results.length === 1) {
    const r = results[0];
    return (
      <ToolCardShell>
        <ToolCardHeader className="py-2.5">
          <ToolCardTitle icon={modeIcon}>
            <span className="text-sm font-medium text-zinc-300">{modeLabel}</span>
            <SourceBadge source={r.agentSource} />
          </ToolCardTitle>
          <ToolCardActions>{statusPill}</ToolCardActions>
        </ToolCardHeader>

        {/* Task preview */}
        <ToolCardSection>
          <div className="text-[10px] font-medium uppercase tracking-wider text-zinc-600 mb-0.5">Task</div>
          <p className="text-[11px] text-zinc-400 whitespace-pre-wrap break-words line-clamp-3">
            {r.task}
          </p>
        </ToolCardSection>

        {/* Error */}
        {(r.exitCode !== 0 || r.stopReason === "error") && r.errorMessage && (
          <div className="px-4 py-2 border-b border-zinc-800/60 bg-red-950/20">
            <span className="text-[11px] text-red-400">{r.errorMessage}</span>
          </div>
        )}

        {/* Tool calls */}
        {getToolCalls(r.messages).length > 0 && (
          <ToolCallTrace toolCalls={getToolCalls(r.messages)} />
        )}

        {/* Final output */}
        {getFinalOutput(r.messages) && (
          <details open className="group/output">
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between gap-2 px-4 py-1.5 border-b border-zinc-800/60 hover:bg-zinc-900 transition-colors">
                <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-600">Output</span>
                <ChevronDownIcon className="size-3 text-zinc-600 transition-transform group-open/output:rotate-180" />
              </div>
            </summary>
            <ToolCardSection className="border-b-0">
              <div className="prose prose-invert prose-xs max-w-none">
                <MessageResponse>{getFinalOutput(r.messages)}</MessageResponse>
              </div>
            </ToolCardSection>
          </details>
        )}

        {/* Usage */}
        <UsageBar usage={r.usage} model={r.model} />
      </ToolCardShell>
    );
  }

  // ── Multi-result (parallel or chain) ─────────────────────────────
  return (
    <ToolCardShell>
      <ToolCardHeader className="py-2.5">
        <ToolCardTitle icon={modeIcon}>
          <span className="text-sm font-medium text-zinc-300">{modeLabel}</span>
        </ToolCardTitle>
        <ToolCardActions>{statusPill}</ToolCardActions>
      </ToolCardHeader>

      {/* Sub-results */}
      <div className="p-2 space-y-1.5">
        {results.map((r, i) => (
          <SingleResultCard key={`${r.agent}-${i}`} result={r} />
        ))}
      </div>

      {/* Total usage */}
      {totalUsage.turns > 0 && (
        <div className="px-4 py-1.5 border-t border-zinc-800/60 text-[10px] font-mono text-zinc-500">
          Total: {formatUsage(totalUsage)}
        </div>
      )}
    </ToolCardShell>
  );
}
