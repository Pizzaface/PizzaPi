/**
 * GitPanel — interactive git GUI panel.
 *
 * Communicates with the runner's GitService entirely through the
 * service_message channel (no REST routes). Session-scoped via cwd.
 *
 * Layout: commit composer pinned at the top (commit-first), then tabs, then
 * the change list. Diff viewing opens a wide modal (GitDiffModal) instead of
 * taking over the whole 320px panel. Sync operations live behind a header ⋯.
 */
import { useState, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import {
    ArrowUp,
    ArrowDown,
    Download,
    Edit3,
    RefreshCw,
    GitCommit,
    Upload,
    Loader2,
    Check,
    AlertCircle,
    MoreHorizontal,
    GitMerge,
    ArrowRightLeft,
    StopCircle,
    Play,
    GitBranch,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useGitService } from "@/hooks/useGitService";
import { GitBranchSelector } from "./GitBranchSelector";
import { GitStagingArea, partitionChanges } from "./GitStagingArea";
import { GitCommitForm } from "./GitCommitForm";
import { GitDiffModal } from "./GitDiffModal";
import { GitWorktreeList } from "./GitWorktreeList";
import { GitStashList } from "./GitStashList";
import { GitHistoryView } from "./GitHistoryView";
import { GitDiffRevsView } from "./GitDiffRevsView";
import { getGitOperationFeedback, parseUpstreamRef, type GitOperationFeedback } from "./git-operation-feedback";

type GitTab = "changes" | "stash" | "history" | "compare";

const GIT_TABS: Array<{ id: GitTab; label: string }> = [
    { id: "changes", label: "Changes" },
    { id: "stash", label: "Stash" },
    { id: "history", label: "History" },
    { id: "compare", label: "Compare" },
];

// ── Props ───────────────────────────────────────────────────────────────────

interface GitPanelProps {
    cwd: string;
    className?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export function GitPanel({ cwd, className }: GitPanelProps) {
    const git = useGitService(cwd);

    // Diff modal state (replaces the old full-panel diff takeover).
    const [diffModal, setDiffModal] = useState<{ open: boolean; path?: string; staged?: boolean }>({
        open: false,
    });

    // Tab + optional path filter (used by history/compare)
    const [activeTab, setActiveTab] = useState<GitTab>("changes");
    const [pathFilter, setPathFilter] = useState("");

    const currentBranchInfo = git.branches.find((b) => b.isCurrent);

    const branchNameForLog = git.status?.branch;
    const currentShortHash = currentBranchInfo?.shortHash;
    useEffect(() => {
        if (!branchNameForLog) return;
        git.fetchLog(undefined, 1).catch(() => {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [branchNameForLog, currentShortHash]);

    const [toast, setToast] = useState<GitOperationFeedback | null>(null);

    const handleSetUpstream = useCallback(() => {
        const currentBranch = git.status?.branch?.trim();
        const suggestion = currentBranch ? `origin/${currentBranch}` : "origin/main";
        const response = window.prompt("Set upstream to which remote branch?", suggestion);
        if (!response) return;
        const parsed = parseUpstreamRef(response);
        if (!parsed) {
            setToast({ type: "error", message: "Enter the upstream as remote/branch, for example origin/main." });
            return;
        }
        git.setUpstream(parsed.remote, parsed.branch);
    }, [git]);

    useEffect(() => {
        if (!git.lastOperationResult) return;
        setToast(getGitOperationFeedback(git.lastOperationResult));
        const timer = setTimeout(() => setToast(null), 5000);
        return () => clearTimeout(timer);
    }, [git.lastOperationResult]);

    const viewDiff = useCallback((path: string, staged = false) => {
        setDiffModal({ open: true, path, staged });
    }, []);

    const handleMerge = useCallback(() => {
        const current = git.status?.branch ?? "";
        const branchName = window.prompt("Merge which branch into current?", "");
        if (!branchName) return;
        if (branchName === current) {
            setToast({ type: "error", message: "Cannot merge the current branch into itself." });
            return;
        }
        git.merge(branchName);
    }, [git]);

    const handleRebase = useCallback(() => {
        const current = git.status?.branch ?? "";
        const branchName = window.prompt("Rebase current branch onto which branch?", "main");
        if (!branchName) return;
        if (branchName === current) {
            setToast({ type: "error", message: "Cannot rebase onto the current branch." });
            return;
        }
        git.rebase(branchName);
    }, [git]);

    // ── Loading / error / empty ───────────────────────────────────────

    if (git.loading && !git.status) {
        return (
            <div className={cn("flex items-center justify-center p-8", className)}>
                <Spinner className="size-5" />
            </div>
        );
    }

    if (git.error && !git.status) {
        return (
            <div className={cn("p-4", className)}>
                <p className="text-sm text-red-400 mb-3">{git.error}</p>
                <Button variant="outline" size="sm" onClick={git.fetchStatus}>
                    <RefreshCw className="size-3 mr-1.5" /> Retry
                </Button>
            </div>
        );
    }

    if (!git.status) return null;

    const { staged } = partitionChanges(git.status.changes);
    const hasChanges = git.status.changes.length > 0;
    const isMutating = git.operationInProgress !== null;
    const isPushing = git.operationInProgress === "push";
    const isPulling = git.operationInProgress === "pull";
    const showPush = git.status.ahead > 0 || !git.status.hasUpstream;
    const showPull = git.status.behind > 0 && git.status.hasUpstream;

    const headLogEntry = git.log[0];
    const logMatchesHead = !!headLogEntry && currentBranchInfo?.shortHash === headLogEntry.shortHash;
    const lastCommitShortHash = currentBranchInfo?.shortHash ?? headLogEntry?.shortHash;
    const lastCommitTooltip = logMatchesHead
        ? `${headLogEntry.shortHash} ${headLogEntry.subject}`
        : currentBranchInfo
            ? `${currentBranchInfo.shortHash} · ${currentBranchInfo.lastCommit}`
            : headLogEntry
                ? `${headLogEntry.shortHash} ${headLogEntry.subject}`
                : undefined;

    return (
        <div className={cn("flex flex-col h-full overflow-hidden", className)}>
            {/* ── Commit-first composer (pinned top) ── */}
            {activeTab === "changes" && (
                <GitCommitForm
                    hasStagedChanges={staged.length > 0}
                    stagedCount={staged.length}
                    onCommit={git.commit}
                    onSuggest={git.suggestCommitMessage}
                    isCommitting={git.operationInProgress === "commit"}
                    disabled={isMutating}
                />
            )}

            {/* ── Status / branch header ── */}
            <div className="flex flex-col @sm:flex-row @sm:items-center gap-2 px-2 py-1.5 border-b border-border bg-muted/50 min-h-[40px] overflow-hidden">
                <div className="flex items-center gap-1.5 min-w-0 w-full @sm:w-auto @sm:flex-1 overflow-hidden">
                    <GitBranchSelector
                        currentBranch={git.status.branch}
                        branches={git.branches}
                        branchesState={git.branchesState}
                        onCheckout={git.checkout}
                        onOpen={git.fetchBranches}
                        disabled={isMutating}
                        isCheckingOut={git.operationInProgress === "checkout"}
                    />
                    {hasChanges && (
                        <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400 text-xs font-medium shrink-0"
                            title={`${git.status.changes.length} dirty change(s)`}
                        >
                            <Edit3 className="size-3" />
                            {git.status.changes.length}
                        </span>
                    )}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-1.5 min-w-0 w-full @sm:w-auto @sm:shrink-0 @sm:ml-auto">
                    {git.status.ahead > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[0.65rem] text-green-600 dark:text-green-400" title={`${git.status.ahead} commit(s) ahead`}>
                            <ArrowUp className="size-3" /> {git.status.ahead}
                        </span>
                    )}
                    {git.status.behind > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[0.65rem] text-amber-500 dark:text-amber-400" title={`${git.status.behind} commit(s) behind`}>
                            <ArrowDown className="size-3" /> {git.status.behind}
                        </span>
                    )}

                    {lastCommitShortHash && (
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span className="inline-flex items-center gap-1 min-w-0 text-xs text-muted-foreground cursor-help">
                                        <GitCommit className="size-3 shrink-0" />
                                        <span className="truncate">{lastCommitShortHash}</span>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">
                                    <p className="max-w-xs break-words">{lastCommitTooltip}</p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    )}

                    {showPull && (
                        <button
                            type="button"
                            onClick={() => git.pull()}
                            disabled={isMutating}
                            className={cn(
                                "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors",
                                "bg-amber-500/20 text-amber-600 dark:text-amber-400 hover:bg-amber-500/30 disabled:opacity-50",
                            )}
                            title="Pull from remote"
                        >
                            {isPulling ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
                            Pull
                        </button>
                    )}

                    {showPush && (
                        <button
                            type="button"
                            onClick={() => git.push(!git.status!.hasUpstream)}
                            disabled={isMutating}
                            className={cn(
                                "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors",
                                "bg-green-600/20 text-green-600 dark:text-green-400 hover:bg-green-600/30 disabled:opacity-50",
                            )}
                            title={git.status!.hasUpstream ? "Push to remote" : "Push & set upstream"}
                        >
                            {isPushing ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
                            {git.status!.hasUpstream ? "Push" : "Publish"}
                        </button>
                    )}

                    {/* Sync ⋯ menu */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                disabled={isMutating}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors bg-muted/60 hover:bg-muted text-foreground disabled:opacity-50"
                                title="Sync options"
                            >
                                <MoreHorizontal className="size-3" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuItem onSelect={() => git.pull(false)} disabled={git.operationInProgress !== null}>
                                <Download className="size-3.5" /> Pull (fast-forward)
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => git.pull(true)} disabled={git.operationInProgress !== null}>
                                <Download className="size-3.5" /> Pull --rebase
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={handleMerge} disabled={git.operationInProgress !== null}>
                                <GitMerge className="size-3.5" /> Merge into current…
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={handleRebase} disabled={git.operationInProgress !== null}>
                                <ArrowRightLeft className="size-3.5" /> Rebase onto…
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={handleSetUpstream} disabled={git.operationInProgress !== null}>
                                <GitBranch className="size-3.5" /> Set upstream…
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>

                    <button
                        type="button"
                        onClick={git.fetchStatus}
                        disabled={git.loading}
                        className="text-muted-foreground hover:text-foreground transition-colors p-1"
                        title="Refresh git status"
                        aria-label="Refresh git status"
                    >
                        <RefreshCw className={cn("size-3.5", git.loading && "animate-spin")} />
                    </button>
                </div>
            </div>

            {/* Toast notification */}
            {toast && (
                <div
                    className={cn(
                        "flex items-center gap-2 px-3 py-1.5 text-xs border-b",
                        toast.type === "success"
                            ? "bg-green-600/10 border-green-600/20 text-green-600 dark:text-green-400"
                            : "bg-red-500/10 border-red-500/20 text-red-500 dark:text-red-400",
                    )}
                >
                    {toast.type === "success" ? <Check className="size-3" /> : <AlertCircle className="size-3" />}
                    <span className="truncate flex-1">{toast.message}</span>
                    {toast.action === "setUpstream" && (
                        <button type="button" onClick={handleSetUpstream} className="text-current underline underline-offset-2 hover:no-underline">
                            Set upstream…
                        </button>
                    )}
                    <button type="button" onClick={() => setToast(null)} className="text-current opacity-60 hover:opacity-100" aria-label="Dismiss">×</button>
                </div>
            )}

            {/* Conflict resolution bar */}
            {(() => {
                const r = git.lastOperationResult;
                const isConflict = r && git.operationInProgress === null
                    && ((r.reason === "conflict") || (r.conflict === true && git.lastConflictType === "git_stash_result"));
                if (!isConflict) return null;
                const isStashConflict = git.lastConflictType === "git_stash_result";
                const isMergeConflict = git.lastConflictType === "git_merge_result";
                return (
                    <div className="flex flex-col @sm:flex-row items-start @sm:items-center gap-2 px-3 py-2 text-xs border-b bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400">
                        <div className="flex items-center gap-2 min-w-0 w-full">
                            <AlertCircle className="size-3 shrink-0" />
                            <span className="truncate flex-1">
                                {isStashConflict
                                    ? "Stash apply hit conflicts. Resolve them in the working tree; the stash entry is preserved."
                                    : "Conflicts detected. Resolve them to continue."}
                            </span>
                        </div>
                        {isMergeConflict ? (
                            <button
                                type="button"
                                onClick={() => git.mergeAbort()}
                                disabled={git.operationInProgress !== null}
                                className="inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-500/20 text-red-500 dark:text-red-400 hover:bg-red-500/30 disabled:opacity-50 w-full @sm:w-auto"
                                title="Abort the merge"
                            >
                                <StopCircle className="size-3" /> Abort Merge
                            </button>
                        ) : isStashConflict ? null : (
                            <div className="flex items-center gap-2 w-full @sm:w-auto">
                                <button
                                    type="button"
                                    onClick={() => git.rebaseContinue()}
                                    disabled={git.operationInProgress !== null}
                                    className="inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-600/20 text-green-600 dark:text-green-400 hover:bg-green-600/30 disabled:opacity-50 flex-1 @sm:flex-initial"
                                    title="Continue rebase after resolving conflicts"
                                >
                                    <Play className="size-3" /> Continue
                                </button>
                                <button
                                    type="button"
                                    onClick={() => git.rebaseAbort()}
                                    disabled={git.operationInProgress !== null}
                                    className="inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-500/20 text-red-500 dark:text-red-400 hover:bg-red-500/30 disabled:opacity-50 flex-1 @sm:flex-initial"
                                    title="Abort the rebase"
                                >
                                    <StopCircle className="size-3" /> Abort
                                </button>
                            </div>
                        )}
                    </div>
                );
            })()}

            {/* Tab strip */}
            <div className="flex items-center gap-0.5 px-1 border-b border-border bg-muted/30 overflow-x-auto min-w-0 [scrollbar-width:thin]">
                {GIT_TABS.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        onClick={() => setActiveTab(t.id)}
                        className={cn(
                            "px-2 py-1 text-[0.65rem] @sm:px-2.5 @sm:py-1.5 @sm:text-xs font-medium whitespace-nowrap border-b-2 -mb-px transition-colors shrink-0",
                            activeTab === t.id
                                ? "border-primary text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {/* Optional path filter for history/compare */}
            {activeTab !== "changes" && activeTab !== "stash" && (
                <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-muted/20 min-w-0">
                    <span className="text-xs text-muted-foreground shrink-0">Path</span>
                    <input
                        type="text"
                        value={pathFilter}
                        onChange={(e) => setPathFilter(e.target.value)}
                        placeholder="optional path/dir"
                        className="min-w-0 flex-1 h-7 rounded border border-input bg-background px-2 text-xs"
                    />
                </div>
            )}

            {/* Content area */}
            <div className="flex-1 overflow-auto min-h-0">
                {activeTab === "changes" && (
                    !hasChanges ? (
                        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
                            <GitCommit className="size-8 opacity-30" />
                            <p className="text-sm">Working tree clean</p>
                        </div>
                    ) : (
                        <GitStagingArea
                            changes={git.status.changes}
                            onViewDiff={viewDiff}
                            onStage={git.stage}
                            onStageAll={git.stageAll}
                            onUnstage={git.unstage}
                            onUnstageAll={git.unstageAll}
                            operationInProgress={git.operationInProgress}
                        />
                    )
                )}
                {activeTab === "stash" && <GitStashList cwd={cwd} />}
                {activeTab === "history" && <GitHistoryView cwd={cwd} path={pathFilter.trim() || undefined} />}
                {activeTab === "compare" && <GitDiffRevsView cwd={cwd} path={pathFilter.trim() || undefined} />}
            </div>

            {/* Worktrees — only on the Changes tab */}
            {activeTab === "changes" && (
                <GitWorktreeList
                    worktrees={git.worktrees}
                    onOpen={git.fetchWorktrees}
                    onAdd={git.addWorktree}
                    onRemove={git.removeWorktree}
                    operationInProgress={git.operationInProgress}
                />
            )}

            {/* Diff modal */}
            <GitDiffModal
                open={diffModal.open}
                onOpenChange={(open) => setDiffModal((p) => ({ open, path: p.path, staged: p.staged }))}
                changes={git.status.changes}
                initialPath={diffModal.path}
                initialStaged={diffModal.staged}
                fetchDiff={git.fetchDiff}
            />
        </div>
    );
}
