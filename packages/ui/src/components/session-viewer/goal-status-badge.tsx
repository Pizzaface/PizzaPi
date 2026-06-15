import * as React from "react";
import { Target } from "lucide-react";
import type { MetaGoalStatus } from "@pizzapi/protocol";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface GoalStatusBadgeProps {
  goal?: MetaGoalStatus | null;
}

/**
 * Header badge that surfaces the active /goal state in the web UI.
 *
 * Shows the goal indicator, current turn count (with budget if set), and a
 * snippet of the last evaluator reason. Hidden automatically when the goal is
 * cleared, met, or otherwise no longer active.
 */
export function GoalStatusBadge({ goal }: GoalStatusBadgeProps) {
  if (!goal || goal.status !== "active") return null;

  const turnText =
    goal.maxTurns !== undefined
      ? `turn ${goal.turnCount}/${goal.maxTurns}`
      : `turn ${goal.turnCount}`;

  const rawReason = goal.lastReason?.replace(/\s+/g, " ").trim();
  const displayReason =
    rawReason && rawReason.length > 45 ? `${rawReason.slice(0, 42)}…` : rawReason;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-emerald-500/40",
            "bg-emerald-500/10 px-2 py-0.5 text-[0.65rem] font-medium text-emerald-700",
            "dark:text-emerald-400 uppercase tracking-wide cursor-default",
          )}
        >
          <Target className="size-3" aria-hidden="true" />
          <span>/goal active</span>
          <span className="opacity-80">· {turnText}</span>
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
          {rawReason && <p className="text-xs normal-case italic">“{rawReason}”</p>}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
