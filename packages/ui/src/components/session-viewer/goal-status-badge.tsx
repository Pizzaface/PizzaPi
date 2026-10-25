import * as React from "react";
import { Hourglass, Target } from "lucide-react";
import type { MetaGoalStatus } from "@pizzapi/protocol";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface GoalStatusBadgeProps {
  goal?: MetaGoalStatus | null;
}

/**
 * Header badge that surfaces the active /goal state in the web UI.
 *
 * Shows the goal indicator, completed agent runs (with budget if set), and a
 * snippet of the last evaluator reason. Hidden automatically when the goal is
 * cleared, met, or otherwise no longer active.
 *
 * `turnCount` counts agent runs — one prompt through to control returning to
 * the user — not LLM round-trips, so the label reads "run".
 *
 * An active goal with `waiting` set is paused until an external event; the
 * badge labels it "waiting" and shows the reason and expected wake event.
 */
export function GoalStatusBadge({ goal }: GoalStatusBadgeProps) {
  if (!goal || goal.status !== "active") return null;

  const turnText =
    goal.maxTurns !== undefined
      ? `run ${goal.turnCount}/${goal.maxTurns}`
      : `run ${goal.turnCount}`;

  const waiting = goal.waiting;
  const rawReason = (waiting?.reason ?? goal.lastReason)?.replace(/\s+/g, " ").trim();
  const displayReason =
    rawReason && rawReason.length > 45 ? `${rawReason.slice(0, 42)}…` : rawReason;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[0.65rem] font-medium",
            "uppercase tracking-wide cursor-default",
            waiting
              ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
          )}
        >
          {waiting ? (
            <Hourglass className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <Target className="size-3 shrink-0" aria-hidden="true" />
          )}
          <span className="shrink-0 whitespace-nowrap">{waiting?.manual ? "/goal paused" : waiting ? "/goal waiting" : "/goal active"}</span>
          <span className="opacity-80 truncate max-w-40">· {waiting?.manual ? "/goal resume to continue" : waiting ? `wakes on ${waiting.wakeOn}` : turnText}</span>
          {displayReason && <span className="opacity-80 truncate max-w-32">· {displayReason}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <div className="space-y-1">
          <p className="font-medium normal-case">{goal.description}</p>
          <p className="text-muted-foreground text-xs normal-case">
            {turnText}
            {goal.maxTokens !== undefined && ` · tokens ${goal.tokenSpend.toLocaleString()}/${goal.maxTokens.toLocaleString()}`}
          </p>
          {waiting && (
            <p className="text-xs normal-case">
              Waiting for <span className="font-mono">{waiting.wakeOn}</span>
            </p>
          )}
          {rawReason && <p className="text-xs normal-case italic">“{rawReason}”</p>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
