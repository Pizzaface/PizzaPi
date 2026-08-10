/**
 * GitWorktreeList — interactive list of git worktrees.
 *
 * Shows each worktree's branch, path, change count, ahead/behind status.
 * Create via a dialog (no free-text prompts); per-row ⋯ menu for copy-path,
 * open-as-session, and remove; list-level prune for stale entries.
 */
import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
    ChevronDown,
    ChevronRight,
    GitBranch,
    ArrowUp,
    ArrowDown,
    FolderGit2,
    Edit3,
    Star,
    Plus,
    Trash2,
    MoreHorizontal,
    Copy,
    ExternalLink,
    Brush,
} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { GitWorktree, GitBranch as GitBranchType } from "@/hooks/useGitService";
import { GitAddWorktreeDialog } from "./GitAddWorktreeDialog";

interface GitWorktreeListProps {
    worktrees: GitWorktree[];
    branches: GitBranchType[];
    currentBranch: string;
    onOpen: () => void;
    onOpenBranches: () => void;
    onAdd?: (branch: string, path: string, opts?: { base?: string; create?: boolean; isRemote?: boolean }) => void;
    onRemove?: (path: string) => void;
    onPrune?: () => void;
    /** Open a worktree as its own session (spawns rooted at the worktree path). */
    onOpenWorktree?: (path: string) => void;
    operationInProgress?: string | null;
    className?: string;
}

export function GitWorktreeList({
    worktrees,
    branches,
    currentBranch,
    onOpen,
    onOpenBranches,
    onAdd,
    onRemove,
    onPrune,
    onOpenWorktree,
    operationInProgress,
    className,
}: GitWorktreeListProps) {
    const [expanded, setExpanded] = useState(false);
    const [addOpen, setAddOpen] = useState(false);

    useEffect(() => {
        if (expanded && worktrees.length === 0) onOpen();
    }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps

    const isBusy = operationInProgress !== null;

    const dialog = onAdd ? (
        <GitAddWorktreeDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            branches={branches}
            currentBranch={currentBranch}
            onOpenBranches={onOpenBranches}
            onCreate={onAdd}
            isBusy={isBusy}
        />
    ) : null;

    // Collapsed state with only the main worktree: show the toggle + New button.
    if (!expanded && worktrees.length <= 1) {
        return (
            <div className={cn("border-t border-border", className)}>
                <div className="flex items-center">
                    <button
                        type="button"
                        onClick={() => { setExpanded(true); onOpen(); }}
                        className="flex items-center gap-1.5 flex-1 px-3 py-1.5 text-xs text-muted-foreground min-h-9 hover:text-foreground hover:bg-muted/50 transition-colors"
                    >
                        <FolderGit2 className="size-3.5 shrink-0" />
                        <span>Worktrees</span>
                        <ChevronRight className="size-3 ml-auto" />
                    </button>
                    {onAdd && (
                        <button
                            type="button"
                            onClick={() => setAddOpen(true)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50 border-l border-border/50 min-h-9"
                            title="New worktree"
                        >
                            <Plus className="size-3" /> New
                        </button>
                    )}
                </div>
                {dialog}
            </div>
        );
    }

    const sorted = [...worktrees].sort((a, b) => {
        if (a.isMain && !b.isMain) return -1;
        if (!a.isMain && b.isMain) return 1;
        return a.branch.localeCompare(b.branch);
    });
    const totalChanges = worktrees.reduce((sum, w) => sum + w.changeCount, 0);

    return (
        <div className={cn("border-t border-border", className)}>
            {/* Header toggle */}
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs font-medium min-h-9 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
                {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                <FolderGit2 className="size-3.5" />
                <span>Worktrees</span>
                {worktrees.length > 1 && (
                    <span className="ml-1 text-[0.6rem] text-muted-foreground/70">({worktrees.length})</span>
                )}
                <span className="flex-1" />
                {totalChanges > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[0.6rem] text-amber-500 dark:text-amber-400 mr-1">
                        <Edit3 className="size-2.5" /> {totalChanges}
                    </span>
                )}
                {onAdd && (
                    <span
                        role="button"
                        tabIndex={0}
                        className="inline-flex items-center justify-center size-5 rounded hover:bg-accent hover:text-foreground transition-colors"
                        title="New worktree"
                        onClick={(e) => { e.stopPropagation(); setAddOpen(true); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setAddOpen(true); } }}
                    >
                        <Plus className="size-3" />
                    </span>
                )}
            </button>

            {/* Worktree rows */}
            {expanded && (
                <div className="pb-1">
                    {sorted.map((wt) => (
                        <WorktreeRow
                            key={wt.path}
                            worktree={wt}
                            onRemove={onRemove}
                            onOpenWorktree={onOpenWorktree}
                            isBusy={isBusy}
                        />
                    ))}
                    {onPrune && (
                        <button
                            type="button"
                            onClick={onPrune}
                            disabled={isBusy}
                            className="flex items-center gap-1.5 w-full px-3 py-1.5 mt-0.5 text-[0.65rem] text-muted-foreground/70 hover:text-foreground hover:bg-muted/50 disabled:opacity-50 transition-colors"
                            title="Delete clean worktrees whose branch is merged or deleted on the remote, and prune metadata for missing directories"
                        >
                            <Brush className="size-3" /> Prune stale worktrees
                        </button>
                    )}
                </div>
            )}
            {dialog}
        </div>
    );
}

// ── Individual worktree row ─────────────────────────────────────────────────

function WorktreeRow({
    worktree: wt,
    onRemove,
    onOpenWorktree,
    isBusy,
}: {
    worktree: GitWorktree;
    onRemove?: (path: string) => void;
    onOpenWorktree?: (path: string) => void;
    isBusy: boolean;
}) {
    const handleRemove = useCallback(() => {
        if (!onRemove || wt.isMain) return;
        const confirmed = window.confirm(
            `Remove worktree "${wt.branch}" at ${wt.displayPath}?\n\nThis will delete the worktree directory and any uncommitted changes.`,
        );
        if (!confirmed) return;
        onRemove(wt.path);
    }, [onRemove, wt]);

    const handleCopy = useCallback(() => {
        try { navigator.clipboard?.writeText(wt.path); } catch { /* clipboard unavailable */ }
    }, [wt.path]);

    const clean = wt.changeCount === 0 && wt.ahead === 0 && wt.behind === 0;

    return (
        <div
            className="flex items-center gap-2 px-3 py-1.5 mx-1 rounded text-xs hover:bg-muted/60 transition-colors group"
            title={wt.path}
        >
            <GitBranch className={cn("size-3 shrink-0", wt.isMain ? "text-amber-500 dark:text-amber-400" : "text-muted-foreground")} />
            <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                    <span className={cn("font-medium truncate", wt.isMain ? "text-foreground" : "text-foreground/90")}>
                        {wt.isDetached ? `(${wt.shortHash})` : wt.branch}
                    </span>
                    {wt.isMain && <Star className="size-2.5 shrink-0 text-amber-500 dark:text-amber-400 fill-current" />}
                </div>
                <span className="text-[0.6rem] text-muted-foreground/70 truncate">
                    {wt.isMain ? "main worktree" : wt.displayPath}
                </span>
            </div>

            {/* Status badges */}
            <div className="flex items-center gap-1.5 shrink-0">
                {wt.changeCount > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[0.6rem] text-amber-500 dark:text-amber-400" title={`${wt.changeCount} change(s)`}>
                        <Edit3 className="size-2.5" /> {wt.changeCount}
                    </span>
                )}
                {wt.ahead > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[0.6rem] text-green-600 dark:text-green-400" title={`${wt.ahead} ahead`}>
                        <ArrowUp className="size-2.5" /> {wt.ahead}
                    </span>
                )}
                {wt.behind > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[0.6rem] text-amber-500 dark:text-amber-400" title={`${wt.behind} behind`}>
                        <ArrowDown className="size-2.5" /> {wt.behind}
                    </span>
                )}
                {clean && <span className="text-[0.6rem] text-muted-foreground/50">clean</span>}
            </div>

            {/* Actions menu */}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        disabled={isBusy}
                        className="shrink-0 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent disabled:opacity-50 opacity-100 @md:opacity-0 @md:group-hover:opacity-100 transition-opacity"
                        title={`Actions for ${wt.branch}`}
                        aria-label={`Actions for ${wt.branch}`}
                    >
                        <MoreHorizontal className="size-3.5" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                    {onOpenWorktree && (
                        <DropdownMenuItem onSelect={() => onOpenWorktree(wt.path)}>
                            <ExternalLink className="size-3.5" /> Open as session
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={handleCopy}>
                        <Copy className="size-3.5" /> Copy path
                    </DropdownMenuItem>
                    {!wt.isMain && onRemove && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={handleRemove} disabled={isBusy}>
                                <Trash2 className="size-3.5" /> Remove worktree
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
