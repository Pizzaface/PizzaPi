/**
 * SubagentResultCard — renders inline subagent tool results as a chat-style card,
 * visually matching the SubAgentConversationCard used for spawn_session inter-agent
 * communication.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────┐
 *   │ 🤖 Subagent: researcher  [user]     ✅ Done │  ← header
 *   ├─────────────────────────────────────────────┤
 *   │                          ┌─────────────────┐│
 *   │                          │ Task prompt …   ││  ← sent bubble (blue)
 *   │                          └─────────────────┘│
 *   │  → 5 tool calls                             │  ← activity line
 *   │ ┌──────────────────────┐                    │
 *   │ │ Agent response …     │                    │  ← received bubble (violet)
 *   │ └──────────────────────┘                    │
 *   ├─────────────────────────────────────────────┤
 *   │ 5 turns · ↑12k · ↓3.2k · $0.02 · sonnet   │  ← usage footer
 *   └─────────────────────────────────────────────┘
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
  ZapIcon,
  LinkIcon,
  WrenchIcon,
} from "lucide-react";
import { ToolCardShell } from "@/components/ui/tool-card";
import { MessageResponse } from "@/components/ai-elements/message";
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
  return parts.join(" · ");
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

function getToolCallCount(messages: Array<{ role: string; content: unknown[] }>): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part && typeof part === "object" && "type" in part && (part as any).type === "toolCall") {
          count++;
        }
      }
    }
  }
  return count;
}

// ── Parse details from top-level details prop ──────────────────────────

function parseSubagentDetails(details: unknown): SubagentDetails | null {
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const d = details as SubagentDetails;
    if (d.mode && d.results) return d;
  }
  return null;
}

// ── Parse details from tool result ─────────────────────────────────────

function parseDetails(content: unknown): SubagentDetails | null {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    if (obj.details && typeof obj.details === "object") {
      const d = obj.details as SubagentDetails;
      if (d.mode && d.results) return d;
    }
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.details && typeof b.details === "object") {
          const d = b.details as SubagentDetails;
          if (d.mode && d.results) return d;
        }
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

// ── Chat bubble sub-components ─────────────────────────────────────────

/** Right-aligned "sent" bubble for the task prompt */
function TaskBubble({ task }: { task: string }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="text-[10px] text-zinc-500 pr-1">Task</div>
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600/25 border border-blue-500/30 px-3 py-2 text-zinc-200 whitespace-pre-wrap break-words leading-relaxed text-[0.8rem]">
        {task}
      </div>
    </div>
  );
}

/** Left-aligned "received" bubble for the agent's output */
function ResponseBubble({ output, agentName }: { output: string; agentName: string }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="text-[10px] text-zinc-500 pl-1">← {agentName}</div>
      <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-violet-600/15 border border-violet-500/25 px-3 py-2 text-zinc-200 leading-relaxed text-[0.8rem]">
        <div className="prose prose-invert prose-xs max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <MessageResponse>{output}</MessageResponse>
        </div>
      </div>
    </div>
  );
}

/** Error bubble — left-aligned, red */
function ErrorBubble({ message, agentName }: { message: string; agentName: string }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="text-[10px] text-red-400/80 pl-1">← {agentName}</div>
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-red-600/15 border border-red-500/25 px-3 py-2 text-red-300 whitespace-pre-wrap break-words leading-relaxed text-[0.8rem]">
        {message}
      </div>
    </div>
  );
}

/** Small inline activity line between bubbles */
function ToolCallActivity({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 px-1">
      <WrenchIcon className="size-3 shrink-0" />
      <span>{count} tool call{count !== 1 ? "s" : ""}</span>
    </div>
  );
}

/** Animated typing/thinking indicator */
function ThinkingBubble() {
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center gap-2.5 rounded-2xl rounded-bl-sm border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-zinc-500 text-[0.8rem]">
        <span className="inline-flex gap-1 items-end">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:300ms]" />
        </span>
      </div>
    </div>
  );
}

// ── Chat exchange for a single result ──────────────────────────────────

function AgentExchange({
  result,
  isRunning,
  showStepLabel,
}: {
  result: SingleResult;
  isRunning: boolean;
  showStepLabel?: boolean;
}) {
  const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
  const finalOutput = getFinalOutput(result.messages);
  const toolCallCount = getToolCallCount(result.messages);

  return (
    <>
      {/* Step label for chain mode */}
      {showStepLabel && result.step !== undefined && (
        <div className="flex items-center gap-2 px-1">
          <div className="h-px flex-1 bg-zinc-800" />
          <span className="text-[10px] font-medium text-zinc-600">
            Step {result.step} · {result.agent}
          </span>
          <div className="h-px flex-1 bg-zinc-800" />
        </div>
      )}

      {/* Task bubble (sent) */}
      <TaskBubble task={result.task} />

      {/* Tool call activity */}
      <ToolCallActivity count={toolCallCount} />

      {/* Agent response or running state */}
      {isRunning ? (
        <ThinkingBubble />
      ) : isError ? (
        <ErrorBubble
          message={result.errorMessage || result.stderr?.slice(0, 300) || `Failed (exit ${result.exitCode})`}
          agentName={result.agent}
        />
      ) : finalOutput ? (
        <ResponseBubble output={finalOutput} agentName={result.agent} />
      ) : (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 pl-1">
          <CheckCircle2Icon className="size-3 shrink-0 text-emerald-500" />
          <span>Completed with no output</span>
        </div>
      )}
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────

export function SubagentResultCard({
  toolInput,
  content,
  isStreaming,
  isError: isErrorProp,
  details: detailsProp,
}: {
  toolInput: unknown;
  content: unknown;
  isStreaming: boolean;
  isError?: boolean;
  details?: unknown;
}) {
  const inputArgs = parseToolInputArgs(toolInput);
  // Try parsing details from content first (streaming path), then fall back
  // to the top-level details prop (preserved from final tool result message).
  const details = parseDetails(content) ?? parseSubagentDetails(detailsProp);
  const resultText = extractTextFromToolContent(content);

  const mode: "single" | "parallel" | "chain" =
    details?.mode ??
    (inputArgs.chain ? "chain" : inputArgs.tasks ? "parallel" : "single");

  const agentName = typeof inputArgs.agent === "string" ? inputArgs.agent : undefined;
  const taskPreview = typeof inputArgs.task === "string" ? inputArgs.task : undefined;

  // ── Determine header bits ────────────────────────────────────────
  const results = details?.results ?? [];
  const running = results.filter((r) => r.exitCode === -1).length;
  const succeeded = results.filter((r) => r.exitCode === 0).length;
  const failed = results.filter((r) => r.exitCode > 0).length;
  const isRunning = running > 0 || isStreaming;

  const ModeIcon = mode === "chain" ? LinkIcon : mode === "parallel" ? ZapIcon : BotIcon;

  const headerLabel = (() => {
    if (mode === "single") {
      const name = results[0]?.agent ?? agentName;
      return name ? `Subagent: ${name}` : "Subagent";
    }
    if (mode === "parallel") return `Subagent: parallel (${results.length || "…"})`;
    return `Subagent: chain (${results.length || "…"} steps)`;
  })();

  const scopeBadge = (() => {
    if (results.length === 1) return results[0].agentSource;
    if (details?.agentScope) return details.agentScope;
    return null;
  })();

  // ── Usage ────────────────────────────────────────────────────────
  const totalUsage = results.length > 0 ? aggregateUsage(results) : null;
  const usageText = totalUsage ? formatUsage(totalUsage, mode === "single" ? results[0]?.model : undefined) : null;

  // ── Status indicator ─────────────────────────────────────────────
  const statusEl = isRunning ? (
    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-violet-400 shrink-0">
      <Loader2Icon className="size-2.5 animate-spin" />
      Active
    </span>
  ) : failed > 0 ? (
    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-red-400 shrink-0">
      <XCircleIcon className="size-3" />
      {mode === "single" ? "Failed" : `${succeeded}/${results.length}`}
    </span>
  ) : results.length > 0 ? (
    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-emerald-400 shrink-0">
      <CheckCircle2Icon className="size-3" />
      {mode === "single" ? "Done" : `${results.length}/${results.length}`}
    </span>
  ) : null;

  // ── No details yet (streaming / waiting) ─────────────────────────
  if (results.length === 0) {
    const hasError = isErrorProp || (resultText?.startsWith("Error") ?? false);

    return (
      <ToolCardShell className="border-zinc-700/80">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
          <ModeIcon className="size-3.5 shrink-0 text-violet-400" />
          <span className="text-[0.8rem] font-semibold text-zinc-300">{headerLabel}</span>
          {isStreaming && !hasError ? (
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-violet-400 shrink-0">
              <Loader2Icon className="size-2.5 animate-spin" />
              Active
            </span>
          ) : hasError ? (
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-red-400 shrink-0">
              <XCircleIcon className="size-3" />
              Failed
            </span>
          ) : resultText ? (
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-emerald-400 shrink-0">
              <CheckCircle2Icon className="size-3" />
              Done
            </span>
          ) : null}
        </div>

        {/* Chat area */}
        <div className="flex flex-col gap-3 px-3 py-3">
          {/* Task bubble if we have it */}
          {taskPreview && <TaskBubble task={taskPreview} />}

          {/* Streaming / waiting */}
          {isStreaming && !resultText && <ThinkingBubble />}

          {/* Plain text result (fallback when no structured details) */}
          {resultText && !hasError && (
            <ResponseBubble output={resultText} agentName={agentName ?? "agent"} />
          )}

          {/* Error result */}
          {hasError && resultText && (
            <ErrorBubble message={resultText} agentName={agentName ?? "agent"} />
          )}
        </div>
      </ToolCardShell>
    );
  }

  // ── Has results — render chat conversation ───────────────────────
  return (
    <ToolCardShell className="border-zinc-700/80">
      {/* Header — matches SubAgentConversationCard */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <ModeIcon className="size-3.5 shrink-0 text-violet-400" />
        <span className="text-[0.8rem] font-semibold text-zinc-300">{headerLabel}</span>
        {scopeBadge && (
          <span className="font-mono text-[10px] text-zinc-400 rounded bg-zinc-800 px-1.5 py-0.5">
            {scopeBadge}
          </span>
        )}
        {statusEl}
      </div>

      {/* Chat bubbles */}
      <div className="flex flex-col gap-3 px-3 py-3 max-h-[32rem] overflow-y-auto">
        {mode === "single" && results.length === 1 ? (
          <AgentExchange result={results[0]} isRunning={results[0].exitCode === -1} />
        ) : mode === "chain" ? (
          // Chain: sequential exchanges with step dividers
          results.map((r, i) => (
            <AgentExchange
              key={`${r.agent}-${i}`}
              result={r}
              isRunning={r.exitCode === -1}
              showStepLabel
            />
          ))
        ) : (
          // Parallel: each agent exchange separated by a divider
          results.map((r, i) => (
            <React.Fragment key={`${r.agent}-${i}`}>
              {i > 0 && (
                <div className="flex items-center gap-2 px-1">
                  <div className="h-px flex-1 bg-zinc-800" />
                  <span className="text-[10px] font-medium text-zinc-600">{r.agent}</span>
                  <div className="h-px flex-1 bg-zinc-800" />
                </div>
              )}
              <AgentExchange result={r} isRunning={r.exitCode === -1} />
            </React.Fragment>
          ))
        )}

        {/* Still running indicator at end */}
        {isRunning && results.every((r) => r.exitCode !== -1) && <ThinkingBubble />}
      </div>

      {/* Usage footer */}
      {usageText && (
        <div className="border-t border-zinc-800 px-3 py-1.5 text-[10px] font-mono text-zinc-500">
          {mode !== "single" && <span className="text-zinc-600 mr-1">Total:</span>}
          {usageText}
        </div>
      )}
    </ToolCardShell>
  );
}
