import * as React from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ProviderIcon } from "@/components/ProviderIcon";
import { ChevronDown, Users } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { GroupSession } from "@/lib/group-status";
import {
  resolveChildSessions,
  computeGroupCounts,
  formatDuration,
  type ChildStatus,
} from "@/lib/group-status";

// ── Types ────────────────────────────────────────────────────────────────────

export interface GroupMembersPanelProps {
  /** The parent session's child IDs */
  childSessionIds: string[];
  /** All live sessions */
  sessions: GroupSession[];
  /** Navigate to a session by ID */
  onNavigate?: (sessionId: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function statusDotClasses(status: ChildStatus): string {
  switch (status) {
    case "active":
      return "bg-green-500 shadow-[0_0_4px_#22c55e80]";
    case "idle":
      return "bg-zinc-400";
    case "completed":
      return "bg-emerald-500";
    case "error":
      return "bg-red-500";
    default:
      return "bg-zinc-500";
  }
}

function statusLabel(status: ChildStatus): string {
  switch (status) {
    case "active":
      return "Active";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "error":
      return "Error";
    default:
      return "Unknown";
  }
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Collapsible panel showing detailed status of all child sessions
 * in a group. Rendered below the topology tree in the session viewer.
 *
 * Each row: session name, model badge, status dot, duration.
 * Click a row to navigate to that session.
 *
 * Renders nothing when there are no children.
 */
export const GroupMembersPanel = React.memo(function GroupMembersPanel({
  childSessionIds,
  sessions,
  onNavigate,
}: GroupMembersPanelProps) {
  const [isOpen, setIsOpen] = React.useState(() => {
    try {
      return localStorage.getItem("pp-group-members-open") !== "false";
    } catch {
      return true;
    }
  });

  const handleOpenChange = React.useCallback((open: boolean) => {
    setIsOpen(open);
    try {
      localStorage.setItem("pp-group-members-open", String(open));
    } catch {
      // best-effort
    }
  }, []);

  const sessionsById = React.useMemo(() => {
    const map = new Map<string, GroupSession>();
    for (const s of sessions) {
      map.set(s.sessionId, s);
    }
    return map;
  }, [sessions]);

  const children = React.useMemo(
    () => resolveChildSessions(childSessionIds, sessionsById),
    [childSessionIds, sessionsById],
  );

  const counts = React.useMemo(
    () => computeGroupCounts(childSessionIds, sessionsById),
    [childSessionIds, sessionsById],
  );

  if (children.length === 0) return null;

  return (
    <Collapsible open={isOpen} onOpenChange={handleOpenChange}>
      <div className="border-b border-border">
        {/* Header */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <Users className="size-3.5" />
            <span className="uppercase tracking-wider flex-1 text-left">
              Group Members
            </span>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
              {counts.completed}/{counts.total}
            </Badge>
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-200",
                isOpen && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>

        {/* Member list */}
        <CollapsibleContent>
          <div className="max-h-48 overflow-y-auto">
            {children.map((child) => (
              <button
                key={child.sessionId}
                type="button"
                onClick={() => onNavigate?.(child.sessionId)}
                className={cn(
                  "flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm transition-colors",
                  "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                title={`${child.displayName} (${statusLabel(child.status)})`}
              >
                {/* Status dot */}
                <span
                  className={cn(
                    "inline-block size-2 rounded-full shrink-0",
                    statusDotClasses(child.status),
                  )}
                  title={statusLabel(child.status)}
                />

                {/* Provider icon */}
                {child.model && (
                  <ProviderIcon
                    provider={child.model.provider}
                    className="size-3.5 shrink-0 opacity-60"
                  />
                )}

                {/* Session name */}
                <span className="truncate flex-1 min-w-0 text-xs">
                  {child.displayName}
                </span>

                {/* Duration */}
                {child.durationMs != null && (
                  <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">
                    {formatDuration(child.durationMs)}
                  </span>
                )}

                {/* Model badge */}
                {child.model && (
                  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] font-mono text-muted-foreground/60 leading-none hidden sm:inline">
                    {child.model.id.length > 16
                      ? child.model.id.slice(0, 14) + "…"
                      : child.model.id}
                  </span>
                )}
              </button>
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});
