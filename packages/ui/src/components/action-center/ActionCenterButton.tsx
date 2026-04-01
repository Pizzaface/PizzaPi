/**
 * ActionCenterButton — bell/inbox icon with badge showing needsResponseCount.
 *
 * Secondary indicator for running count. Click opens the ActionCenter drawer.
 * Designed to be placed in both desktop and mobile headers.
 */
import * as React from "react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useNeedsResponseCount, useRunningCount } from "@/attention/provider";

interface ActionCenterButtonProps {
  onClick: () => void;
  className?: string;
  /** Compact mode for tight mobile headers — smaller button, no tooltip. */
  compact?: boolean;
}

export const ActionCenterButton = React.memo(function ActionCenterButton({
  onClick,
  className,
  compact = false,
}: ActionCenterButtonProps) {
  const needsResponse = useNeedsResponseCount();
  const running = useRunningCount();

  const button = (
    <Button
      variant="ghost"
      size="icon"
      className={cn(compact ? "h-8 w-8" : "h-9 w-9", "relative", className)}
      onClick={onClick}
      aria-label={`Action center${needsResponse > 0 ? ` — ${needsResponse} items need response` : ""}`}
    >
      <Inbox className={cn(compact ? "h-4 w-4" : "h-4 w-4")} />

      {/* Primary badge — needs_response count */}
      {needsResponse > 0 && (
        <span
          className={cn(
            "absolute flex items-center justify-center rounded-full bg-amber-500 text-white font-bold shadow-[0_0_6px_#f59e0b80]",
            compact ? "-top-0.5 -right-0.5 min-w-[14px] h-[14px] text-[8px] px-0.5" : "-top-0.5 -right-0.5 min-w-[16px] h-[16px] text-[9px] px-1",
          )}
        >
          {needsResponse > 9 ? "9+" : needsResponse}
        </span>
      )}

      {/* Secondary indicator — running dot */}
      {running > 0 && needsResponse === 0 && (
        <span
          className={cn(
            "absolute rounded-full bg-blue-400 animate-pulse",
            compact ? "-top-0 -right-0 h-2 w-2" : "-top-0 -right-0 h-2.5 w-2.5",
          )}
        />
      )}
    </Button>
  );

  if (compact) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {button}
      </TooltipTrigger>
      <TooltipContent>
        Action Center
        {needsResponse > 0 && ` • ${needsResponse} need response`}
        {running > 0 && ` • ${running} running`}
      </TooltipContent>
    </Tooltip>
  );
});
