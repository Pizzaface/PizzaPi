/**
 * Session Tree Viewer — browse and navigate the session's branch history.
 *
 * Shows the full tree of messages in the session, highlights the current
 * leaf (active conversation point), and lets the user navigate to any
 * node or fork from it.
 */
import * as React from "react";
import { GitBranchIcon, GitForkIcon, ChevronRightIcon, ChevronDownIcon, UserIcon, BotIcon, WrenchIcon, PackageIcon, BookmarkIcon, ScissorsIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SessionTreeNode } from "@/lib/remote-exec";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TreeViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tree: SessionTreeNode[];
  leafId: string | null;
  onNavigate: (targetId: string, summarize?: boolean) => void;
  onFork: (entryId: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function roleIcon(role?: string, type?: string) {
  if (type === "compaction") return <ScissorsIcon className="size-3.5 text-muted-foreground shrink-0" />;
  if (type === "branch_summary") return <BookmarkIcon className="size-3.5 text-muted-foreground shrink-0" />;
  switch (role) {
    case "user": return <UserIcon className="size-3.5 text-blue-500 shrink-0" />;
    case "assistant": return <BotIcon className="size-3.5 text-green-500 shrink-0" />;
    case "tool": return <WrenchIcon className="size-3.5 text-amber-500 shrink-0" />;
    case "toolResult": return <PackageIcon className="size-3.5 text-amber-500 shrink-0" />;
    default: return <ChevronRightIcon className="size-3.5 text-muted-foreground shrink-0" />;
  }
}

function roleLabel(role?: string, type?: string): string {
  if (type === "compaction") return "compaction";
  if (type === "branch_summary") return "branch summary";
  if (type === "thinking_level_change") return "thinking level";
  if (type === "model_change") return "model change";
  return role ?? type ?? "entry";
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Count total visible nodes in a tree (for showing stats). */
function countNodes(nodes: SessionTreeNode[]): number {
  let count = 0;
  for (const n of nodes) {
    count += 1 + countNodes(n.children);
  }
  return count;
}

/** Check if a node is an ancestor of the given leafId. */
function isOnActivePath(node: SessionTreeNode, leafId: string | null, cache: Map<string, boolean>): boolean {
  if (!leafId) return false;
  const cached = cache.get(node.id);
  if (cached !== undefined) return cached;
  if (node.id === leafId) { cache.set(node.id, true); return true; }
  for (const child of node.children) {
    if (isOnActivePath(child, leafId, cache)) {
      cache.set(node.id, true);
      return true;
    }
  }
  cache.set(node.id, false);
  return false;
}

// ── Tree Node Component ──────────────────────────────────────────────────────

interface TreeNodeProps {
  node: SessionTreeNode;
  leafId: string | null;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  activePathCache: Map<string, boolean>;
  /** Filter — hide tool/toolResult for compact view */
  compactMode: boolean;
}

function TreeNode({ node, leafId, depth, selectedId, onSelect, activePathCache, compactMode }: TreeNodeProps) {
  const isLeaf = node.id === leafId;
  const isActive = isOnActivePath(node, leafId, activePathCache);
  const isSelected = node.id === selectedId;
  const [expanded, setExpanded] = React.useState(isActive || depth < 2);

  // In compact mode, skip tool/toolResult nodes unless they're branch points
  if (compactMode && (node.role === "tool" || node.role === "toolResult") && !node.isBranchPoint && node.children.length <= 1) {
    // Still render children
    return (
      <>
        {node.children.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            leafId={leafId}
            depth={depth}
            selectedId={selectedId}
            onSelect={onSelect}
            activePathCache={activePathCache}
            compactMode={compactMode}
          />
        ))}
      </>
    );
  }

  // Skip model_change and thinking_level_change entries in compact mode
  if (compactMode && (node.type === "model_change" || node.type === "thinking_level_change")) {
    return (
      <>
        {node.children.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            leafId={leafId}
            depth={depth}
            selectedId={selectedId}
            onSelect={onSelect}
            activePathCache={activePathCache}
            compactMode={compactMode}
          />
        ))}
      </>
    );
  }

  const hasChildren = node.children.length > 0;
  const preview = node.preview
    ? node.preview.length > 120 ? node.preview.slice(0, 120) + "…" : node.preview
    : roleLabel(node.role, node.type);

  return (
    <div className="relative">
      {/* Connector line */}
      {depth > 0 && (
        <div
          className={cn(
            "absolute top-0 bottom-0 border-l-2",
            isActive ? "border-primary/40" : "border-border/50",
          )}
          style={{ left: `${(depth - 1) * 20 + 10}px` }}
        />
      )}

      <div
        className={cn(
          "flex items-start gap-1.5 py-1 px-2 rounded-md cursor-pointer text-sm transition-colors group",
          isSelected && "bg-primary/15 ring-1 ring-primary/30",
          isLeaf && !isSelected && "bg-accent/60",
          !isSelected && !isLeaf && "hover:bg-muted/60",
        )}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
        onClick={() => onSelect(node.id)}
      >
        {/* Expand/collapse toggle */}
        {hasChildren ? (
          <button
            className="shrink-0 p-0.5 -ml-1 rounded hover:bg-muted"
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          >
            {expanded
              ? <ChevronDownIcon className="size-3.5 text-muted-foreground" />
              : <ChevronRightIcon className="size-3.5 text-muted-foreground" />
            }
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}

        {/* Role icon */}
        {roleIcon(node.role, node.type)}

        {/* Content */}
        <div className="flex-1 min-w-0">
          <span className={cn(
            "block truncate",
            isLeaf && "font-medium",
            isActive && !isLeaf && "text-foreground",
            !isActive && "text-muted-foreground",
          )}>
            {preview}
          </span>
        </div>

        {/* Badges */}
        <div className="flex items-center gap-1 shrink-0">
          {node.isBranchPoint && (
            <GitBranchIcon className="size-3.5 text-orange-500" />
          )}
          {isLeaf && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-primary border-primary/40">
              active
            </Badge>
          )}
          {node.label && (
            <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
              {node.label}
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {formatTimestamp(node.timestamp)}
          </span>
        </div>
      </div>

      {/* Children */}
      {expanded && hasChildren && node.children.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          leafId={leafId}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
          activePathCache={activePathCache}
          compactMode={compactMode}
        />
      ))}
    </div>
  );
}

// ── Main Dialog ──────────────────────────────────────────────────────────────

export function TreeViewerDialog({ open, onOpenChange, tree, leafId, onNavigate, onFork }: TreeViewerDialogProps) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [compactMode, setCompactMode] = React.useState(true);
  const totalNodes = React.useMemo(() => countNodes(tree), [tree]);
  const activePathCache = React.useMemo(() => new Map<string, boolean>(), [tree, leafId]);

  // Find the selected node info
  const selectedNode = React.useMemo(() => {
    if (!selectedId) return null;
    function find(nodes: SessionTreeNode[]): SessionTreeNode | null {
      for (const n of nodes) {
        if (n.id === selectedId) return n;
        const found = find(n.children);
        if (found) return found;
      }
      return null;
    }
    return find(tree);
  }, [selectedId, tree]);

  const isSelectedLeaf = selectedId === leafId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GitBranchIcon className="size-5 text-primary" />
              <DialogTitle className="text-base">Session Tree</DialogTitle>
              <DialogDescription className="sr-only">Browse and navigate the session's conversation tree</DialogDescription>
              <span className="text-xs text-muted-foreground">
                {totalNodes} entries
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setCompactMode(!compactMode)}
              >
                {compactMode ? "Show all" : "Compact"}
              </Button>
            </div>
          </div>
        </DialogHeader>

        {/* Tree view */}
        <div className="flex-1 overflow-y-auto p-2 min-h-0">
          {tree.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
              No session history
            </div>
          ) : (
            tree.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                leafId={leafId}
                depth={0}
                selectedId={selectedId}
                onSelect={setSelectedId}
                activePathCache={activePathCache}
                compactMode={compactMode}
              />
            ))
          )}
        </div>

        {/* Action bar */}
        {selectedNode && (
          <div className="border-t px-4 py-3 flex items-center justify-between gap-3 shrink-0 bg-muted/30">
            <div className="flex items-center gap-2 min-w-0 text-sm">
              {roleIcon(selectedNode.role, selectedNode.type)}
              <span className="truncate text-muted-foreground">
                {selectedNode.preview
                  ? selectedNode.preview.slice(0, 80) + (selectedNode.preview.length > 80 ? "…" : "")
                  : roleLabel(selectedNode.role, selectedNode.type)
                }
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!isSelectedLeaf && (
                <Button
                  size="sm"
                  variant="default"
                  className="h-8"
                  onClick={() => {
                    onNavigate(selectedNode.id);
                    onOpenChange(false);
                  }}
                >
                  <GitBranchIcon className="size-3.5 mr-1.5" />
                  Branch here
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() => {
                  onFork(selectedNode.id);
                  onOpenChange(false);
                }}
              >
                <GitForkIcon className="size-3.5 mr-1.5" />
                Fork
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
