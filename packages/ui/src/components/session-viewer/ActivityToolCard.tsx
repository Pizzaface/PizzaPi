import * as React from "react";
import { ChevronRightIcon, Loader2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";
import { summarizeToolActivity } from "@/components/session-viewer/activity-summary";

/**
 * A tool call rendered as one line of human-language activity.
 *
 * Used by modes with `toolRendering: "activity"`. The detailed card is not
 * replaced — it is the expanded state — so nothing is hidden from the user,
 * it just stops being the default way a non-coding mode reads.
 */
export function ActivityToolCard({
  toolName,
  toolInput,
  isError,
  isStreaming,
  children,
}: {
  toolName?: string;
  toolInput: unknown;
  isError?: boolean;
  isStreaming?: boolean;
  /** The detailed rendering, shown when the line is expanded. */
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const summary = React.useMemo(
    () => summarizeToolActivity(toolName, toolInput, isError),
    [toolName, toolInput, isError],
  );

  return (
    <div className="my-0.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
          "hover:bg-muted/60",
          isError && "text-destructive",
        )}
      >
        {isStreaming ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <DynamicLucideIcon
            name={summary.icon}
            className={cn("size-3.5 shrink-0", isError ? "text-destructive" : "text-muted-foreground")}
          />
        )}
        <span className={cn("truncate", isError ? "" : "text-foreground/90")}>{summary.label}</span>
        {summary.detail && (
          <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">{summary.detail}</span>
        )}
        <ChevronRightIcon
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground/50 transition-transform",
            "opacity-0 group-hover:opacity-100",
            expanded && "rotate-90 opacity-100",
          )}
        />
      </button>
      {expanded && children && <div className="mt-1 pl-2">{children}</div>}
    </div>
  );
}
