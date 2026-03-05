import * as React from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import type { GroupSession } from "@/lib/group-status";
import { computeGroupCounts } from "@/lib/group-status";

// ── Types ────────────────────────────────────────────────────────────────────

export interface GroupStatusBadgeProps {
  /** The child session IDs for this session */
  childSessionIds: string[];
  /** All live sessions (used to look up child statuses) */
  sessions: GroupSession[];
  /** Additional CSS class names */
  className?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Pill-shaped badge showing group completion progress: "X/Y completed".
 *
 * Only renders when childSessionIds is non-empty. Updates in real-time
 * as child session states change via hub heartbeats.
 */
export const GroupStatusBadge = React.memo(function GroupStatusBadge({
  childSessionIds,
  sessions,
  className,
}: GroupStatusBadgeProps) {
  const counts = React.useMemo(() => {
    if (childSessionIds.length === 0) return null;
    const byId = new Map<string, GroupSession>();
    for (const s of sessions) {
      byId.set(s.sessionId, s);
    }
    return computeGroupCounts(childSessionIds, byId);
  }, [childSessionIds, sessions]);

  if (!counts || counts.total === 0) return null;

  const allDone = counts.completed === counts.total;
  const hasErrors = counts.error > 0;
  const hasActive = counts.active > 0;

  // Pick styling based on state
  let variant: "secondary" | "outline" | "destructive" = "secondary";
  let icon: React.ReactNode = null;

  if (allDone) {
    icon = <CheckCircle2 className="size-3 text-emerald-500" />;
  } else if (hasErrors) {
    variant = "outline";
    icon = <AlertCircle className="size-3 text-red-400" />;
  } else if (hasActive) {
    icon = <Loader2 className="size-3 animate-spin text-blue-400" />;
  }

  return (
    <Badge
      variant={variant}
      className={cn(
        "text-[0.6rem] px-1.5 py-0 h-4 gap-1 font-normal",
        allDone && "border-emerald-500/30 text-emerald-500",
        hasErrors && !allDone && "border-red-400/30 text-red-400",
        className,
      )}
    >
      {icon}
      <span className="tabular-nums">
        {counts.completed}/{counts.total}
      </span>
    </Badge>
  );
});
