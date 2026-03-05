import * as React from "react";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/ProviderIcon";
import { ChevronRight, Network } from "lucide-react";
import type { HubSession } from "@/components/SessionSidebar";
import { buildSessionTree, type TreeNode } from "@/lib/session-topology";

// Re-export for convenience
export { buildSessionTree } from "@/lib/session-topology";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SessionTopologyProps {
  /** The currently viewed session ID */
  currentSessionId: string;
  /** All live sessions (includes parentSessionId / childSessionIds) */
  sessions: HubSession[];
  /** Navigate to a session by ID */
  onNavigate: (sessionId: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Truncate a session ID for display (first 8 chars with ellipsis).
 */
function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Status dot color classes based on session state.
 */
function statusDotClasses(session: HubSession): string {
  if (session.isActive) {
    return "bg-green-500 shadow-[0_0_4px_#22c55e80]"; // active
  }

  // Check last heartbeat — if recent, session is idle (gray)
  if (session.lastHeartbeatAt) {
    const hbAge = Date.now() - new Date(session.lastHeartbeatAt).getTime();
    // If heartbeat is very stale (> 60s), treat as potentially errored/disconnected
    if (hbAge > 60_000) {
      return "bg-red-500"; // error/disconnected
    }
    return "bg-zinc-400"; // idle
  }

  return "bg-zinc-400"; // idle/unknown
}

function statusLabel(session: HubSession): string {
  if (session.isActive) return "Active";
  if (session.lastHeartbeatAt) {
    const hbAge = Date.now() - new Date(session.lastHeartbeatAt).getTime();
    if (hbAge > 60_000) return "Disconnected";
    return "Idle";
  }
  return "Unknown";
}

// ── Components ───────────────────────────────────────────────────────────────

function TreeNodeItem({
  node,
  currentSessionId,
  onNavigate,
  depth,
}: {
  node: TreeNode<HubSession>;
  currentSessionId: string;
  onNavigate: (sessionId: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = React.useState(true);
  const { session } = node;
  const isCurrent = session.sessionId === currentSessionId;
  const hasChildren = node.children.length > 0;
  const displayName = session.sessionName?.trim() || truncateId(session.sessionId);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (isCurrent && hasChildren) {
            setExpanded((v) => !v);
          } else {
            onNavigate(session.sessionId);
          }
        }}
        className={cn(
          "flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md transition-colors text-sm",
          isCurrent
            ? "bg-accent text-accent-foreground font-medium"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        title={`${displayName} (${statusLabel(session)})`}
      >
        {/* Expand/collapse chevron */}
        {hasChildren ? (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-150",
              expanded && "rotate-90",
            )}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}

        {/* Status dot */}
        <span
          className={cn(
            "inline-block size-2 rounded-full shrink-0",
            statusDotClasses(session),
          )}
          title={statusLabel(session)}
        />

        {/* Provider icon */}
        {session.model && (
          <ProviderIcon
            provider={session.model.provider}
            className="size-3.5 shrink-0 opacity-60"
          />
        )}

        {/* Session name */}
        <span className="truncate flex-1 min-w-0">{displayName}</span>

        {/* Model badge */}
        {session.model && (
          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-mono text-muted-foreground leading-none">
            {session.model.id.length > 20
              ? session.model.id.slice(0, 18) + "…"
              : session.model.id}
          </span>
        )}
      </button>

      {/* Children */}
      {hasChildren && expanded && (
        <div>
          {node.children.map((child) => (
            <TreeNodeItem
              key={child.session.sessionId}
              node={child}
              currentSessionId={currentSessionId}
              onNavigate={onNavigate}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Session topology tree — shows parent→child session hierarchy.
 *
 * Renders nothing when the current session has no parent or children,
 * keeping the UI clean for single-agent workflows.
 */
export const SessionTopology = React.memo(function SessionTopology({
  currentSessionId,
  sessions,
  onNavigate,
}: SessionTopologyProps) {
  const tree = React.useMemo(
    () => buildSessionTree(currentSessionId, sessions),
    [currentSessionId, sessions],
  );

  if (tree.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 border-b border-border pb-1">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5">
        <Network className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Agent Tree
        </span>
      </div>

      {/* Tree */}
      <div className="flex flex-col">
        {tree.map((root) => (
          <TreeNodeItem
            key={root.session.sessionId}
            node={root}
            currentSessionId={currentSessionId}
            onNavigate={onNavigate}
            depth={0}
          />
        ))}
      </div>
    </div>
  );
});
