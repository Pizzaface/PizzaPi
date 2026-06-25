/**
 * GitPanel — interactive git GUI panel.
 *
 * Communicates with the runner's GitService entirely through the
 * service_message channel (no REST routes). Session-scoped via cwd.
 */
import { useState, useCallback, useRef, useEffect } from "react";
import * as ReactDOM from "react-dom";
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
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { useGitService } from "@/hooks/useGitService";
import { GitBranchSelector } from "./GitBranchSelector";
import { GitStagingArea, partitionChanges } from "./GitStagingArea";
import { GitCommitForm } from "./GitCommitForm";
import { GitDiffView } from "./GitDiffView";
import { GitWorktreeList } from "./GitWorktreeList";
import { GitStashList } from "./GitStashList";
import { GitHistoryView } from "./GitHistoryView";
import { GitBlameView } from "./GitBlameView";
import { GitDiffRevsView } from "./GitDiffRevsView";
import { getGitOperationFeedback, parseUpstreamRef, type GitOperationFeedback } from "./git-operation-feedback";

type GitTab = "changes" | "stash" | "history" | "blame" | "compare";

const GIT_TABS: Array<{ id: GitTab; label: string }> = [
    { id: "changes", label: "Changes" },
    { id: "stash", label: "Stash" },
    { id: "history", label: "History" },
    { id: "blame", label: "Blame" },
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

    // Diff view state
    const [selectedDiff, setSelectedDiff] = useState<{ path: string; diff: string } | null>(null);
    const [diffLoading, setDiffLoading] = useState(false);
    const diffContainerRef = useRef<HTMLDivElement>(null);

    // Tab + optional path filter (used by history/blame/compare)
    const [activeTab, setActiveTab] = useState<GitTab>("changes");
    const [pathFilter, setPathFilter] = useState("");

    // Fetch the last commit subject for the status row. Falls back to the
    // branch list's date text if log hasn't resolved yet.
    const branchNameForLog = git.status?.branch;
    useEffect(() => {
        if (!branchNameForLog) return;
        // ponytail: one-entry log fetch, fire-and-forget; hook discards stale cwd results
        git.fetchLog(undefined, 1).catch(() => {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [branchNameForLog]);

    // Toast-style feedback for operations
    const [toast, setToast] = useState<GitOperationFeedback | null>(null);
    const [syncMenuOpen, setSyncMenuOpen] = useState(false);
    const syncMenuRef = useRef<HTMLDivElement>(null);
    const syncMenuContentRef = useRef<HTMLDivElement>(null);

    const handleSetUpstream = useCallback(() => {
        const currentBranch = git.status?.branch?.trim();
        const suggestion = currentBranch ? `origin/${currentBranch}` : "origin/main";
        const response = window.prompt("Set upstream to which remote branch?", suggestion);
        if (!response) return;

        const parsed = parseUpstreamRef(response);
        if (!parsed) {
            setToast({
                type: "error",
                message: "Enter the upstream as remote/branch, for example origin/main.",
            });
            return;
        }

        git.setUpstream(parsed.remote, parsed.branch);
    }, [git]);

    // Show toast when operation completes
    useEffect(() => {
        if (!git.lastOperationResult) return;
        setToast(getGitOperationFeedback(git.lastOperationResult));

        const timer = setTimeout(() => setToast(null), 5000);
        return () => clearTimeout(timer);
    }, [git.lastOperationResult]);

    // Close sync menu on outside click
    useEffect(() => {
        if (!syncMenuOpen) return;
        const handler = (e: PointerEvent) => {
            const target = e.target as Node;
            if (syncMenuRef.current?.contains(target)) return;
            if (syncMenuContentRef.current?.contains(target)) return;
            setSyncMenuOpen(false);
        };
        document.addEventListener("pointerdown", handler, true);
        return () => document.removeEventListener("pointerdown", handler, true);
    }, [syncMenuOpen]);

    // ── Diff viewing ────────────────────────────────────────────────────

    const viewDiff = useCallback(
        async (path: string, staged = false) => {
            setDiffLoading(true);
            try {
                const diff = await git.fetchDiff(path, staged);
                setSelectedDiff({ path, diff });
            } catch {
                setSelectedDiff({ path, diff: "(failed to load diff)" });
            } finally {
                setDiffLoading(false);
            }
        },
        [git],
    );

    const handleMerge = useCallback(() => {
        const current = git.status?.branch ?? "";
        const branchName = window.prompt("Merge which branch into current?", "");
        if (!branchName) return;
        if (branchName === current) {
            setToast({ type: "error", message: "Cannot merge the current branch into itself." });
            return;
        }
        git.merge(branchName);
    }, [git, setToast]);

    const handleRebase = useCallback(() => {
        const current = git.status?.branch ?? "";
        const branchName = window.prompt("Rebase current branch onto which branch?", "main");
        if (!branchName) return;
        if (branchName === current) {
            setToast({ type: "error", message: "Cannot rebase onto the current branch." });
            return;
        }
        git.rebase(branchName);
    }, [git, setToast]);

    // Intercept Escape in diff view
    useEffect(() => {
        if (!selectedDiff) return;
        diffContainerRef.current?.focus();
        const handler = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            // Only intercept if focus is inside the diff container
            const active = document.activeElement;
            if (!active || active === document.body || !diffContainerRef.current?.contains(active)) {
                // Also intercept if body-focused and diff is visible (click on non-focusable content)
                if (active === document.body && diffContainerRef.current) {
                    // ok — intercept
                } else {
                    return;
                }
            }
            e.preventDefault();
            e.stopImmediatePropagation();
            setSelectedDiff(null);
        };
        const restoreFocus = (e: PointerEvent) => {
            if (!diffContainerRef.current?.contains(e.target as Node)) return;
            requestAnimationFrame(() => {
                if (document.activeElement === document.body) {
                    diffContainerRef.current?.focus();
                }
            });
        };
        document.addEventListener("keydown", handler, true);
        document.addEventListener("pointerdown", restoreFocus);
        return () => {
            document.removeEventListener("keydown", handler, true);
            document.removeEventListener("pointerdown", restoreFocus);
        };
    }, [selectedDiff]);

    // ── Loading state ───────────────────────────────────────────────────

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

    // ── Diff view ───────────────────────────────────────────────────────

    if (selectedDiff) {
        return (
            <div ref={diffContainerRef} tabIndex={-1} className={cn("flex flex-col h-full outline-none", className)}>
                <GitDiffView
                    path={selectedDiff.path}
                    diff={selectedDiff.diff}
                    onClose={() => setSelectedDiff(null)}
                />
            </div>
        );
    }

    // ── Main view ───────────────────────────────────────────────────────

    const { staged } = partitionChanges(git.status.changes);
    const hasChanges = git.status.changes.length > 0;
    const isMutating = git.operationInProgress !== null;
    const isPushing = git.operationInProgress === "push";
    const isPulling = git.operationInProgress === "pull";
    // Show push when ahead of remote OR on a branch with no upstream yet
    const showPush = git.status.ahead > 0 || !git.status.hasUpstream;
    const showPull = git.status.behind > 0 && git.status.hasUpstream;

    const currentBranchInfo = git.branches.find((b) => b.isCurrent);
    const lastCommitSubject = git.log[0]?.subject;
    const lastCommitText = lastCommitSubject
        ? `${currentBranchInfo?.shortHash ?? ""} ${lastCommitSubject}`.trim()
        : currentBranchInfo
            ? `${currentBranchInfo.shortHash} ${currentBranchInfo.lastCommit}`
            : undefined;

    return (
        <div className={cn("flex flex-col h-full overflow-hidden", className)}>
            {/* Status / branch header */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 px-2 py-1.5 border-b border-border bg-muted/50 min-h-[40px] overflow-hidden">
                <div className="flex items-center gap-1.5 min-w-0 w-full sm:w-auto sm:flex-1 overflow-hidden">
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

                <div className="flex flex-wrap items-center justify-end gap-1.5 min-w-0 w-full sm:w-auto sm:shrink-0 sm:ml-auto">
                    {/* Ahead/behind badges */}
                    {git.status.ahead > 0 && (
                        <span
                            className="inline-flex items-center gap-0.5 text-[0.65rem] text-green-600 dark:text-green-400"
                            title={`${git.status.ahead} commit(s) ahead`}
                        >
                            <ArrowUp className="size-3" /> {git.status.ahead}
                        </span>
                    )}
                    {git.status.behind > 0 && (
                        <span
                            className="inline-flex items-center gap-0.5 text-[0.65rem] text-amber-500 dark:text-amber-400"
                            title={`${git.status.behind} commit(s) behind`}
                        >
                            <ArrowDown className="size-3" /> {git.status.behind}
                        </span>
                    )}

                    {lastCommitText && (
                        <span
                            className="hidden sm:inline-flex items-center gap-1 min-w-0 text-xs text-muted-foreground"
                            title="Last commit"
                        >
                            <GitCommit className="size-3 shrink-0" />
                            <span className="truncate">{lastCommitText}</span>
                        </span>
                    )}

                    {/* Sync dropdown */}
                    <div className="relative" ref={syncMenuRef}>
                        <button
                            type="button"
                            onClick={() => setSyncMenuOpen((o) => !o)}
                            disabled={isMutating}
                            className={cn(
                                "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors",
                                "bg-muted/60 hover:bg-muted text-foreground",
                                git.operationInProgress && "opacity-70",
                            )}
                            title="Sync options"
                        >
                            <MoreHorizontal className="size-3" /> Sync
                        </button>
                        {syncMenuOpen && ReactDOM.createPortal(
                            <div
                                ref={syncMenuContentRef}
                                style={(() => {
                                    const rect = syncMenuRef.current?.getBoundingClientRect();
                                    const width = 192;
                                    const padding = 8;
                                    const viewportW = typeof window !== "undefined" ? window.innerWidth : width + padding * 2;
                                    const left = rect
                                        ? Math.max(padding, Math.min(rect.left, viewportW - width - padding))
                                        : padding;
                                    return {
                                        position: "fixed",
                                        top: rect ? rect.bottom : 0,
                                        left,
                                        zIndex: 100,
                                        minWidth: width,
                                    };
                                })()}
                                className="mt-1 w-48 bg-popover border border-border rounded-md shadow-lg text-sm"
                            >
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSyncMenuOpen(false);
                                        git.pull(false);
                                    }}
                                    className="w-full text-left px-3 py-2 hover:bg-accent/50 disabled:opacity-50"
                                    disabled={git.operationInProgress !== null}
                                >
                                    <div className="flex items-center gap-2"><Download className="size-3" /> Pull (fast-forward)</div>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSyncMenuOpen(false);
                                        git.pull(true);
                                    }}
                                    className="w-full text-left px-3 py-2 hover:bg-accent/50 disabled:opacity-50"
                                    disabled={git.operationInProgress !== null}
                                >
                                    <div className="flex items-center gap-2"><Download className="size-3" /> Pull --rebase</div>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSyncMenuOpen(false);
                                        handleMerge();
                                    }}
                                    className="w-full text-left px-3 py-2 hover:bg-accent/50 disabled:opacity-50"
                                    disabled={git.operationInProgress !== null}
                                >
                                    <div className="flex items-center gap-2"><GitMerge className="size-3" /> Merge into current…</div>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setSyncMenuOpen(false);
                                        handleRebase();
                                    }}
                                    className="w-full text-left px-3 py-2 hover:bg-accent/50 disabled:opacity-50"
                                    disabled={git.operationInProgress !== null}
                                >
                                    <div className="flex items-center gap-2"><ArrowRightLeft className="size-3" /> Rebase onto…</div>
                                </button>
                            </div>,
                            document.body,
                        )}
                    </div>

                    {/* Pull button */}
                    {showPull && (
                        <button
                            type="button"
                            onClick={() => git.pull()}
                            disabled={isMutating}
                            className={cn(
                                "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors",
                                "bg-amber-500/20 text-amber-600 dark:text-amber-400 hover:bg-amber-500/30",
                                "disabled:opacity-50",
                            )}
                            title="Pull from remote"
                        >
                            {isPulling ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
                            Pull
                        </button>
                    )}

                    {/* Push button */}
                    {showPush && (
                        <button
                            type="button"
                            onClick={() => git.push(!git.status!.hasUpstream)}
                            disabled={isMutating}
                            className={cn(
                                "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors",
                                "bg-green-600/20 text-green-600 dark:text-green-400 hover:bg-green-600/30",
                                "disabled:opacity-50",
                            )}
                            title={git.status!.hasUpstream ? "Push to remote" : "Push & set upstream"}
                        >
                            {isPushing ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
                            {git.status!.hasUpstream ? "Push" : "Publish"}
                        </button>
                    )}

                    {/* Refresh */}
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
                        <button
                            type="button"
                            onClick={handleSetUpstream}
                            className="text-current underline underline-offset-2 hover:no-underline"
                        >
                            Set upstream…
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => setToast(null)}
                        className="text-current opacity-60 hover:opacity-100"
                    >
                        ×
                    </button>
                </div>
            )}

            {/* Conflict resolution bar */}
            {(() => {
                const r = git.lastOperationResult;
                const isConflict =
                    r && git.operationInProgress === null
                    && ((r.reason === "conflict")
                        || (r.conflict === true && git.lastConflictType === "git_stash_result"));
                if (!isConflict) return null;
                const isStashConflict = git.lastConflictType === "git_stash_result";
                const isMergeConflict = git.lastConflictType === "git_merge_result";
                return (
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 px-3 py-2 text-xs border-b bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400"
                    >
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
                                className="inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-500/20 text-red-500 dark:text-red-400 hover:bg-red-500/30 disabled:opacity-50 w-full sm:w-auto"
                                title="Abort the merge"
                            >
                                <StopCircle className="size-3" /> Abort Merge
                            </button>
                        ) : isStashConflict ? null : (
                            <div className="flex items-center gap-2 w-full sm:w-auto">
                                <button
                                    type="button"
                                    onClick={() => git.rebaseContinue()}
                                    disabled={git.operationInProgress !== null}
                                    className="inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-600/20 text-green-600 dark:text-green-400 hover:bg-green-600/30 disabled:opacity-50 flex-1 sm:flex-initial"
                                    title="Continue rebase after resolving conflicts"
                                >
                                    <Play className="size-3" /> Continue
                                </button>
                                <button
                                    type="button"
                                    onClick={() => git.rebaseAbort()}
                                    disabled={git.operationInProgress !== null}
                                    className="inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-500/20 text-red-500 dark:text-red-400 hover:bg-red-500/30 disabled:opacity-50 flex-1 sm:flex-initial"
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
                            "px-2 py-1 text-[0.65rem] sm:px-2.5 sm:py-1.5 sm:text-xs font-medium whitespace-nowrap border-b-2 -mb-px transition-colors shrink-0",
                            activeTab === t.id
                                ? "border-primary text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {/* Optional path filter for history/blame/compare */}
            {activeTab !== "changes" && activeTab !== "stash" && (
                <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-muted/20 min-w-0">
                    <span className="text-xs text-muted-foreground shrink-0">
                        {activeTab === "blame" ? "File" : "Path"}
                    </span>
                    <input
                        type="text"
                        value={pathFilter}
                        onChange={(e) => setPathFilter(e.target.value)}
                        placeholder={activeTab === "blame" ? "path/to/file (required)" : "optional path/dir"}
                        className={cn(
                            "min-w-0 flex-1 h-7 rounded border border-input bg-background px-2 text-xs",
                            activeTab === "blame" && !pathFilter.trim() && "border-red-500/60",
                        )}
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
                {activeTab === "blame" && (
                    pathFilter.trim()
                        ? <GitBlameView cwd={cwd} path={pathFilter.trim()} />
                        : <div className="p-4 text-xs text-muted-foreground">Enter a file path above to blame.</div>
                )}
                {activeTab === "compare" && <GitDiffRevsView cwd={cwd} path={pathFilter.trim() || undefined} />}
            </div>

            {/* Worktrees + commit form — only on the Changes tab to keep other views full-height */}
            {activeTab === "changes" && (
                <GitWorktreeList
                    worktrees={git.worktrees}
                    onOpen={git.fetchWorktrees}
                    onAdd={git.addWorktree}
                    onRemove={git.removeWorktree}
                    operationInProgress={git.operationInProgress}
                />
            )}

            {activeTab === "changes" && hasChanges && (
                <GitCommitForm
                    hasStagedChanges={staged.length > 0}
                    onCommit={git.commit}
                    isCommitting={git.operationInProgress === "commit"}
                    disabled={isMutating}
                />
            )}

            {/* Diff loading indicator */}
            {diffLoading && (
                <div className="flex items-center justify-center py-4 border-t border-border">
                    <Spinner className="size-4" />
                    <span className="text-xs text-muted-foreground ml-2">Loading diff…</span>
                </div>
            )}
        </div>
    );
}
