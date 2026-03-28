import { cn } from "@/lib/utils";
import { Plus, Minus, Edit3, FileQuestion, HelpCircle, File, ChevronUp, ChevronDown } from "lucide-react";
import type { GitChange } from "@/hooks/useGitService";

// ── Status helpers ──────────────────────────────────────────────────────────

function gitStatusLabel(status: string): { label: string; color: string; icon: React.ReactNode } {
    switch (status) {
        case "M":
            return { label: "Modified", color: "text-amber-500 dark:text-amber-400", icon: <Edit3 className="size-3" /> };
        case "A":
            return { label: "Added", color: "text-green-600 dark:text-green-400", icon: <Plus className="size-3" /> };
        case "D":
            return { label: "Deleted", color: "text-red-500 dark:text-red-400", icon: <Minus className="size-3" /> };
        case "R":
            return { label: "Renamed", color: "text-blue-500 dark:text-blue-400", icon: <Edit3 className="size-3" /> };
        case "C":
            return { label: "Copied", color: "text-blue-500 dark:text-blue-400", icon: <Plus className="size-3" /> };
        case "??":
            return { label: "Untracked", color: "text-muted-foreground", icon: <FileQuestion className="size-3" /> };
        case "!!":
            return { label: "Ignored", color: "text-muted-foreground/60", icon: <HelpCircle className="size-3" /> };
        case "MM":
            return { label: "Modified (staged+unstaged)", color: "text-amber-500 dark:text-amber-400", icon: <Edit3 className="size-3" /> };
        case "AM":
            return { label: "Added + Modified", color: "text-green-600 dark:text-green-400", icon: <Plus className="size-3" /> };
        default:
            return { label: status, color: "text-muted-foreground", icon: <File className="size-3" /> };
    }
}

// ── Partition helpers ────────────────────────────────────────────────────────

export function partitionChanges(changes: GitChange[]): {
    staged: GitChange[];
    unstaged: GitChange[];
} {
    const staged: GitChange[] = [];
    const unstaged: GitChange[] = [];

    for (const c of changes) {
        // Porcelain v1: XY where X=index status, Y=worktree status
        if (c.status.length === 2 && c.status[0] !== "?" && c.status[0] !== " " && c.status[0] !== "!") {
            staged.push(c);
        }
        if (c.status === "??" || (c.status.length === 2 && c.status[1] !== " ")) {
            unstaged.push(c);
        }
    }

    return { staged, unstaged };
}

// ── Props ───────────────────────────────────────────────────────────────────

interface GitStagingAreaProps {
    changes: GitChange[];
    onViewDiff: (path: string, staged?: boolean) => void;
    onStage: (paths: string[]) => void;
    onStageAll: () => void;
    onUnstage: (paths: string[]) => void;
    onUnstageAll: () => void;
    operationInProgress: string | null;
}

// ── Component ───────────────────────────────────────────────────────────────

export function GitStagingArea({
    changes,
    onViewDiff,
    onStage,
    onStageAll,
    onUnstage,
    onUnstageAll,
    operationInProgress,
}: GitStagingAreaProps) {
    const { staged, unstaged } = partitionChanges(changes);
    const isBusy = operationInProgress === "stage" || operationInProgress === "unstage";

    return (
        <div className="py-1">
            {/* Staged changes */}
            {staged.length > 0 && (
                <div className="mb-1">
                    <div className="flex items-center px-3 py-1.5">
                        <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground flex-1">
                            Staged Changes ({staged.length})
                        </span>
                        <button
                            type="button"
                            onClick={onUnstageAll}
                            disabled={isBusy}
                            className="text-[0.6rem] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 flex items-center gap-0.5"
                            title="Unstage all"
                        >
                            <ChevronDown className="size-3" /> Unstage All
                        </button>
                    </div>
                    {staged.map((change) => {
                        const info = gitStatusLabel(change.status[0]);
                        return (
                            <div
                                key={`staged-${change.path}`}
                                className="flex items-center gap-1 w-full px-3 py-1 text-sm group"
                            >
                                <button
                                    type="button"
                                    onClick={() => onUnstage([change.path])}
                                    disabled={isBusy}
                                    className="flex-shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                                    title={`Unstage ${change.path}`}
                                >
                                    <Minus className="size-3" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onViewDiff(change.path, true)}
                                    className="flex items-center gap-2 flex-1 min-w-0 text-left hover:bg-accent/40 rounded px-1 py-0.5 transition-colors"
                                >
                                    <span className={cn("flex-shrink-0", info.color)} title={info.label}>{info.icon}</span>
                                    <span className="truncate flex-1 font-mono text-xs text-foreground/80">{change.path}</span>
                                    <span className={cn("text-[0.6rem] flex-shrink-0", info.color)}>{change.status[0]}</span>
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Unstaged/untracked changes */}
            {unstaged.length > 0 && (
                <div>
                    <div className="flex items-center px-3 py-1.5">
                        <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground flex-1">
                            Changes ({unstaged.length})
                        </span>
                        <button
                            type="button"
                            onClick={onStageAll}
                            disabled={isBusy}
                            className="text-[0.6rem] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 flex items-center gap-0.5"
                            title="Stage all"
                        >
                            <ChevronUp className="size-3" /> Stage All
                        </button>
                    </div>
                    {unstaged.map((change) => {
                        const displayStatus = change.status === "??" ? "??" : change.status.length === 2 ? change.status[1] : change.status;
                        const info = gitStatusLabel(displayStatus);
                        const isUntracked = change.status === "??";
                        return (
                            <div
                                key={`unstaged-${change.path}`}
                                className="flex items-center gap-1 w-full px-3 py-1 text-sm group"
                            >
                                <button
                                    type="button"
                                    onClick={() => onStage([change.path])}
                                    disabled={isBusy}
                                    className="flex-shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                                    title={`Stage ${change.path}`}
                                >
                                    <Plus className="size-3" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => !isUntracked && onViewDiff(change.path)}
                                    disabled={isUntracked}
                                    className={cn(
                                        "flex items-center gap-2 flex-1 min-w-0 text-left rounded px-1 py-0.5 transition-colors",
                                        !isUntracked && "hover:bg-accent/40",
                                        isUntracked && "cursor-default",
                                    )}
                                >
                                    <span className={cn("flex-shrink-0", info.color)} title={info.label}>{info.icon}</span>
                                    <span className="truncate flex-1 font-mono text-xs text-foreground/80">{change.path}</span>
                                    <span className={cn("text-[0.6rem] flex-shrink-0", info.color)}>{displayStatus}</span>
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
