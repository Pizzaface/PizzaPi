/**
 * GitWorktreeList — collapsible list of active git worktrees.
 *
 * Shows each worktree's branch, relative path, change count,
 * and ahead/behind status. VS Code-inspired layout.
 */
import { useState, useEffect } from "react";
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
} from "lucide-react";
import type { GitWorktree } from "@/hooks/useGitService";

interface GitWorktreeListProps {
    worktrees: GitWorktree[];
    onOpen: () => void;
    className?: string;
}

export function GitWorktreeList({ worktrees, onOpen, className }: GitWorktreeListProps) {
    const [expanded, setExpanded] = useState(false);

    // Fetch worktrees when first expanded
    useEffect(() => {
        if (expanded && worktrees.length === 0) {
            onOpen();
        }
    }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps

    // Don't render if there's only one worktree (the main one) or none loaded yet while collapsed
    if (!expanded && worktrees.length <= 1) {
        // Still show the toggle if we haven't fetched yet
        return (
            <button
                type="button"
                onClick={() => { setExpanded(true); onOpen(); }}
                className={cn(
                    "flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-muted-foreground",
                    "hover:text-foreground hover:bg-muted/50 transition-colors border-t border-border",
                    className,
                )}
            >
                <FolderGit2 className="size-3.5 shrink-0" />
                <span>Worktrees</span>
                <ChevronRight className="size-3 ml-auto" />
            </button>
        );
    }

    // Sort: main first, then alphabetical by branch
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
                className={cn(
                    "flex items-center gap-1.5 w-full px-3 py-1.5 text-xs font-medium",
                    "text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors",
                )}
            >
                {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                <FolderGit2 className="size-3.5" />
                <span>Worktrees</span>
                {worktrees.length > 1 && (
                    <span className="ml-1 text-[0.6rem] text-muted-foreground/70">
                        ({worktrees.length})
                    </span>
                )}
                {totalChanges > 0 && (
                    <span className="ml-auto inline-flex items-center gap-0.5 text-[0.6rem] text-amber-500 dark:text-amber-400">
                        <Edit3 className="size-2.5" />
                        {totalChanges}
                    </span>
                )}
            </button>

            {/* Worktree list */}
            {expanded && (
                <div className="pb-1">
                    {sorted.map((wt) => (
                        <WorktreeRow key={wt.path} worktree={wt} />
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Individual worktree row ─────────────────────────────────────────────────

function WorktreeRow({ worktree: wt }: { worktree: GitWorktree }) {
    return (
        <div
            className={cn(
                "flex items-center gap-2 px-3 py-1 mx-1 rounded text-xs",
                "hover:bg-muted/60 transition-colors group",
            )}
            title={wt.path}
        >
            {/* Branch icon + name */}
            <GitBranch className="size-3 shrink-0 text-muted-foreground" />
            <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                    <span className={cn(
                        "font-medium truncate",
                        wt.isMain ? "text-foreground" : "text-foreground/90",
                    )}>
                        {wt.isDetached ? `(${wt.shortHash})` : wt.branch}
                    </span>
                    {wt.isMain && (
                        <Star className="size-2.5 shrink-0 text-amber-500 dark:text-amber-400 fill-current" />
                    )}
                </div>
                <span className="text-[0.6rem] text-muted-foreground/70 truncate">
                    {wt.isMain ? "(main worktree)" : wt.displayPath}
                </span>
            </div>

            {/* Badges: changes, ahead, behind */}
            <div className="flex items-center gap-1.5 shrink-0">
                {wt.changeCount > 0 && (
                    <span
                        className="inline-flex items-center gap-0.5 text-[0.6rem] text-amber-500 dark:text-amber-400"
                        title={`${wt.changeCount} change(s)`}
                    >
                        <Edit3 className="size-2.5" />
                        {wt.changeCount}
                    </span>
                )}
                {wt.ahead > 0 && (
                    <span
                        className="inline-flex items-center gap-0.5 text-[0.6rem] text-green-600 dark:text-green-400"
                        title={`${wt.ahead} ahead`}
                    >
                        <ArrowUp className="size-2.5" />
                        {wt.ahead}
                    </span>
                )}
                {wt.behind > 0 && (
                    <span
                        className="inline-flex items-center gap-0.5 text-[0.6rem] text-amber-500 dark:text-amber-400"
                        title={`${wt.behind} behind`}
                    >
                        <ArrowDown className="size-2.5" />
                        {wt.behind}
                    </span>
                )}
                {wt.changeCount === 0 && wt.ahead === 0 && wt.behind === 0 && (
                    <span className="text-[0.6rem] text-muted-foreground/50">clean</span>
                )}
            </div>
        </div>
    );
}
