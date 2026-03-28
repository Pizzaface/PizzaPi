/**
 * GitPanel — interactive git GUI panel.
 *
 * Communicates with the runner's GitService entirely through the
 * service_message channel (no REST routes). Session-scoped via cwd.
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import {
    ArrowUp,
    ArrowDown,
    RefreshCw,
    GitCommit,
    Upload,
    Loader2,
    Check,
    AlertCircle,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { useGitService } from "@/hooks/useGitService";
import { GitBranchSelector } from "./GitBranchSelector";
import { GitStagingArea, partitionChanges } from "./GitStagingArea";
import { GitCommitForm } from "./GitCommitForm";
import { GitDiffView } from "./GitDiffView";

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

    // Toast-style feedback for operations
    const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

    // Show toast when operation completes
    useEffect(() => {
        if (!git.lastOperationResult) return;
        const result = git.lastOperationResult;
        if (result.ok) {
            const messages: Record<string, string> = {
                summary: (result.summary as string) ?? "Done",
                output: (result.output as string) ?? "Done",
                branch: `Switched to ${result.branch as string}`,
            };
            const msg = messages.summary ?? messages.output ?? messages.branch ?? "Done";
            setToast({ type: "success", message: msg });
        } else {
            setToast({
                type: "error",
                message: (result.message as string) ?? "Operation failed",
            });
        }

        const timer = setTimeout(() => setToast(null), 5000);
        return () => clearTimeout(timer);
    }, [git.lastOperationResult]);

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
    const isPushing = git.operationInProgress === "push";
    const showPush = git.status.ahead > 0;

    return (
        <div className={cn("flex flex-col h-full", className)}>
            {/* Branch header */}
            <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-muted/50 min-h-[40px]">
                <GitBranchSelector
                    currentBranch={git.status.branch}
                    branches={git.branches}
                    onCheckout={git.checkout}
                    onOpen={git.fetchBranches}
                    isCheckingOut={git.operationInProgress === "checkout"}
                />

                <div className="flex-1" />

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

                {/* Push button */}
                {showPush && (
                    <button
                        type="button"
                        onClick={() => git.push()}
                        disabled={isPushing}
                        className={cn(
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors",
                            "bg-green-600/20 text-green-600 dark:text-green-400 hover:bg-green-600/30",
                            "disabled:opacity-50",
                        )}
                        title="Push to remote"
                    >
                        {isPushing ? <Loader2 className="size-3 animate-spin" /> : <Upload className="size-3" />}
                        Push
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
                    <button
                        type="button"
                        onClick={() => setToast(null)}
                        className="text-current opacity-60 hover:opacity-100"
                    >
                        ×
                    </button>
                </div>
            )}

            {/* Content area */}
            <div className="flex-1 overflow-auto">
                {!hasChanges ? (
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
                )}
            </div>

            {/* Commit form — always visible at bottom when there are changes */}
            {hasChanges && (
                <GitCommitForm
                    hasStagedChanges={staged.length > 0}
                    onCommit={git.commit}
                    isCommitting={git.operationInProgress === "commit"}
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
