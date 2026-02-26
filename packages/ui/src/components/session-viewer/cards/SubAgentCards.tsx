import * as React from "react";
import { InboxIcon, Loader2Icon, ClockIcon, BotIcon } from "lucide-react";
import { ToolCardShell } from "@/components/ui/tool-card";
import { truncateSessionId } from "@/components/session-viewer/cards/InterAgentCards";
import type { SubAgentTurn } from "@/components/session-viewer/types";

export function SubAgentTurnBubble({ turn }: { turn: SubAgentTurn }) {
  if (turn.type === "sent") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="text-[10px] text-zinc-500 pr-1">
          → {truncateSessionId(turn.sessionId)}
          {turn.isError && <span className="text-red-400 ml-1">error</span>}
        </div>
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600/25 border border-blue-500/30 px-3 py-2 text-zinc-200 whitespace-pre-wrap break-words leading-relaxed text-[0.8rem]">
          {turn.message || <span className="italic text-zinc-500">(empty)</span>}
        </div>
        {turn.isStreaming && (
          <div className="flex items-center gap-1 text-[10px] text-zinc-500 pr-1">
            <Loader2Icon className="size-2.5 animate-spin" /> Sending…
          </div>
        )}
      </div>
    );
  }

  if (turn.type === "received") {
    return (
      <div className="flex flex-col items-start gap-1">
        <div className="text-[10px] text-zinc-500 pl-1">
          ← {truncateSessionId(turn.fromSessionId)}
        </div>
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-emerald-600/15 border border-emerald-500/25 px-3 py-2 text-zinc-200 whitespace-pre-wrap break-words leading-relaxed text-[0.8rem]">
          {turn.message}
        </div>
      </div>
    );
  }

  if (turn.type === "waiting") {
    if (turn.isTimedOut) {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 pl-1">
          <ClockIcon className="size-3 shrink-0" />
          Timed out
          {turn.fromSessionId ? ` · from ${truncateSessionId(turn.fromSessionId)}` : ""}
        </div>
      );
    }
    if (turn.isCancelled) {
      return <div className="text-[11px] text-zinc-600 pl-1">Wait cancelled</div>;
    }
    // Actively waiting — show animated dots
    return (
      <div className="flex flex-col items-start gap-1">
        {turn.fromSessionId && (
          <div className="text-[10px] text-zinc-500 pl-1">
            ← {truncateSessionId(turn.fromSessionId)}
          </div>
        )}
        <div className="flex items-center gap-2.5 rounded-2xl rounded-bl-sm border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-zinc-500 text-[0.8rem]">
          <span className="inline-flex gap-1 items-end">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:300ms]" />
          </span>
          {turn.timeout ? (
            <span className="text-[10px] text-zinc-600">{turn.timeout}s timeout</span>
          ) : null}
        </div>
      </div>
    );
  }

  if (turn.type === "check") {
    if (turn.isStreaming) {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 pl-1">
          <Loader2Icon className="size-3 animate-spin" /> Checking messages…
        </div>
      );
    }
    if (turn.isEmpty) {
      return (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 pl-1">
          <InboxIcon className="size-3 shrink-0" /> No pending messages
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1.5">
        {turn.messages.map((m, idx) => (
          <div key={idx} className="flex flex-col items-start gap-1">
            <div className="text-[10px] text-zinc-500 pl-1">
              ← {truncateSessionId(m.fromSessionId)}
            </div>
            <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-teal-600/15 border border-teal-500/25 px-3 py-2 text-zinc-200 whitespace-pre-wrap break-words leading-relaxed text-[0.8rem]">
              {m.message}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return null;
}

export function SubAgentConversationCard({ turns }: { turns: SubAgentTurn[] }) {
  // Collect unique remote session IDs for the header
  const sessionIds = new Set<string>();
  for (const turn of turns) {
    if (turn.type === "sent") sessionIds.add(turn.sessionId);
    else if (turn.type === "received") sessionIds.add(turn.fromSessionId);
    else if (turn.type === "waiting" && turn.fromSessionId) sessionIds.add(turn.fromSessionId);
    else if (turn.type === "check") {
      if (turn.fromSessionId) sessionIds.add(turn.fromSessionId);
      for (const m of turn.messages) sessionIds.add(m.fromSessionId);
    }
  }

  const lastTurn = turns.at(-1);
  const isActive =
    lastTurn &&
    ((lastTurn.type === "waiting" && lastTurn.isStreaming) ||
      (lastTurn.type === "sent" && lastTurn.isStreaming) ||
      (lastTurn.type === "check" && lastTurn.isStreaming));

  return (
    <ToolCardShell className="border-zinc-700/80">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <BotIcon className="size-3.5 shrink-0 text-violet-400" />
        <span className="text-[0.8rem] font-semibold text-zinc-300">Sub-agent</span>
        <div className="flex flex-wrap gap-1 min-w-0">
          {[...sessionIds].map((id) => (
            <span
              key={id}
              className="font-mono text-[10px] text-zinc-400 rounded bg-zinc-800 px-1.5 py-0.5"
            >
              {truncateSessionId(id)}
            </span>
          ))}
        </div>
        {isActive && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-violet-400 shrink-0">
            <Loader2Icon className="size-2.5 animate-spin" />
            Active
          </span>
        )}
      </div>

      {/* Chat bubbles */}
      <div className="flex flex-col gap-3 px-3 py-3 max-h-[28rem] overflow-y-auto">
        {turns.map((turn, i) => (
          <SubAgentTurnBubble key={i} turn={turn} />
        ))}
      </div>
    </ToolCardShell>
  );
}
