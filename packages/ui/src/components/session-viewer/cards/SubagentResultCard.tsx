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
  ChevronDownIcon,
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
import { renderGroupedToolExecution } from "@/components/session-viewer/tool-rendering";

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

// ── Tool execution extraction ──────────────────────────────────────────

interface ToolExecution {
  toolKey: string;
  toolName: string;
  toolInput: unknown;
  content: unknown;
  isError: boolean;
}

/**
 * Extract tool call + result pairs from the subagent's messages array.
 * Works for both pi-native messages (uses `id` field, object arguments) and
 * Claude Code synthetic messages (uses `id` field from the XML parser).
 * Also handles the NDJSON normalizer convention of `toolCallId` field and
 * stringified arguments defensively.
 */
function extractToolExecutions(messages: Array<{ role: string; content: unknown[] }>): ToolExecution[] {
  const executions: ToolExecution[] = [];

  // First pass: collect all tool calls from assistant messages
  interface PendingCall { id: string; name: string; input: unknown }
  const pendingCalls: PendingCall[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type !== "toolCall") continue;

        // Defensive: check both id and toolCallId (pi-ai uses id, NDJSON normalizer uses toolCallId)
        const id = typeof p.toolCallId === "string" ? p.toolCallId
          : typeof p.id === "string" ? p.id
          : "";
        const name = typeof p.name === "string" ? p.name : "unknown";

        // Defensive: handle arguments as object or string (NDJSON normalizer produces string)
        let input: unknown = p.arguments;
        if (typeof input === "string") {
          try { input = JSON.parse(input); } catch { input = {}; }
        }

        pendingCalls.push({ id, name, input });
      }
    }
  }

  // Second pass: match tool results to pending calls in order
  const matchedIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "toolResult") continue;
    const m = msg as Record<string, unknown>;
    const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";

    // Find matching pending call
    const matchIdx = pendingCalls.findIndex(c => c.id && c.id === toolCallId && !matchedIds.has(c.id));
    if (matchIdx < 0) continue;

    const call = pendingCalls[matchIdx];
    matchedIds.add(call.id);

    executions.push({
      toolKey: call.id || `tool-${executions.length}`,
      toolName: typeof m.toolName === "string" ? m.toolName : call.name,
      toolInput: call.input,
      content: m.content,
      isError: m.isError === true,
    });
  }

  // Include unmatched calls (no result yet — e.g. truncated or still running)
  for (const call of pendingCalls) {
    if (call.id && matchedIds.has(call.id)) continue;
    executions.push({
      toolKey: call.id || `tool-${executions.length}`,
      toolName: call.name,
      toolInput: call.input,
      content: null,
      isError: false,
    });
  }

  return executions;
}

// ── Inline tool cards for subagent tool calls ──────────────────────────

/** Renders inline tool cards for subagent tool calls. Must be a React
 *  component (not a helper function) because renderGroupedToolExecution
 *  creates child components that use hooks (useSessionActions). */
function SubagentToolCallsSection({ executions }: { executions: ToolExecution[] }) {
  if (executions.length === 0) return null;

  const autoOpen = executions.length === 1;

  return (
    <details open={autoOpen || undefined} className="group/tools">
      <summary className="cursor-pointer list-none">
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 px-1 py-0.5 hover:text-zinc-400 transition-colors">
          <WrenchIcon className="size-3 shrink-0" />
          <span>{executions.length} tool call{executions.length !== 1 ? "s" : ""}</span>
          <ChevronDownIcon className="size-3 transition-transform group-open/tools:rotate-180" />
        </div>
      </summary>
      <div className="flex flex-col gap-2 pl-1 border-l-2 border-zinc-800 ml-1.5 mt-1 mb-1">
        {executions.map((exec) => (
          <div key={exec.toolKey} className="[&>*]:text-xs">
            {renderGroupedToolExecution(
              exec.toolKey,
              exec.toolName,
              exec.toolInput,
              exec.content,
              exec.isError,
              false,       // isStreaming — always false for completed subagents
              undefined,   // thinking
              undefined,   // thinkingDuration
              undefined,   // details
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

// ── Parse details from top-level details prop ──────────────────────────

function parseSubagentDetails(details: unknown): SubagentDetails | null {
  return isValidDetails(details) ? details : null;
}

// ── Parse details from tool result ─────────────────────────────────────

/** Validate that a single result entry has the minimum shape for safe rendering */
function isValidResultEntry(r: unknown): r is SingleResult {
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  const obj = r as Record<string, unknown>;
  return (
    typeof obj.agent === "string" &&
    typeof obj.exitCode === "number" &&
    typeof obj.task === "string" &&
    Array.isArray(obj.messages) &&
    obj.usage !== null &&
    typeof obj.usage === "object"
  );
}

/** Validate that a candidate object is a well-formed SubagentDetails */
function isValidDetails(d: unknown): d is SubagentDetails {
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  const obj = d as Record<string, unknown>;
  if (
    typeof obj.mode !== "string" ||
    !Array.isArray(obj.results) ||
    (obj.mode !== "single" && obj.mode !== "parallel" && obj.mode !== "chain")
  ) {
    return false;
  }
  // Validate each result entry to prevent render crashes from malformed data
  return obj.results.every(isValidResultEntry);
}

function parseDetails(content: unknown): SubagentDetails | null {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;
    if (obj.details && typeof obj.details === "object") {
      if (isValidDetails(obj.details)) return obj.details;
    }
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.details && typeof b.details === "object") {
          if (isValidDetails(b.details)) return b.details;
        }
        if (b.type === "text" && typeof b.text === "string") {
          try {
            const parsed = JSON.parse(b.text);
            if (isValidDetails(parsed)) return parsed;
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
  const toolExecutions = extractToolExecutions(result.messages);

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

      {/* Inline tool cards */}
      <SubagentToolCallsSection executions={toolExecutions} />

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
  // Prefer the trusted top-level details prop (from final tool result message)
  // over content-embedded details (streaming path). This avoids misinterpreting
  // arbitrary agent output JSON that coincidentally matches the details shape.
  const details = parseSubagentDetails(detailsProp) ?? parseDetails(content);
  const resultText = extractTextFromToolContent(content);

  const mode: "single" | "parallel" | "chain" =
    details?.mode ??
    (inputArgs.chain ? "chain" : inputArgs.tasks ? "parallel" : "single");

  const agentName = typeof inputArgs.agent === "string" ? inputArgs.agent : undefined;
  const taskPreview = typeof inputArgs.task === "string" ? inputArgs.task : undefined;

  // ── Determine header bits ────────────────────────────────────────
  const results = details?.results ?? [];
  const running = results.filter((r) => r.exitCode === -1).length;
  const isFailed = (r: SingleResult) =>
    r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
  const succeeded = results.filter((r) => r.exitCode !== -1 && !isFailed(r)).length;
  const failed = results.filter((r) => r.exitCode !== -1 && isFailed(r)).length;
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
