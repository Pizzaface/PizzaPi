import * as React from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  GitBranch,
  GitCommit,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  ChevronLeft,
} from "lucide-react";
import { GitStatus } from "./types";
import { shouldInterceptEscape, gitStatusLabel } from "./utils";

// ── Git Changes View ──────────────────────────────────────────────────────────

export function GitChangesView({
  runnerId,
  cwd,
  outerRef,
}: {
  runnerId: string;
  cwd: string;
  /** Ref to the outer FileExplorer container (tab strip, breadcrumb, controls).
   *  When provided the Escape handler covers the full panel chrome, not just
   *  the inner diff body. */
  outerRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [gitStatus, setGitStatus] = React.useState<GitStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedDiff, setSelectedDiff] = React.useState<{ path: string; diff: string } | null>(null);
  const [diffLoading, setDiffLoading] = React.useState(false);

  const fetchStatus = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/git-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as any;
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as any;
      setGitStatus({
        branch: data.branch ?? "",
        changes: Array.isArray(data.changes) ? data.changes : [],
        ahead: data.ahead ?? 0,
        behind: data.behind ?? 0,
        diffStaged: data.diffStaged ?? "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [runnerId, cwd]);

  React.useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Intercept Escape when viewing a diff so it closes the diff preview
  // instead of propagating to SessionViewer's abort handler.
  const diffContainerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!selectedDiff) return;
    // Move focus into the preview container so Escape is intercepted even when
    // the preview was opened via mouse click (no keyboard focus in container yet).
    diffContainerRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Guard against focus being in the inner diff body OR anywhere in the
      // surrounding FileExplorer chrome (tab strip, cwd breadcrumb, position
      // picker, close button).  Without the outerRef check those chrome elements
      // are outside diffContainerRef and would let Escape reach the abort handler.
      const innerOk = shouldInterceptEscape(diffContainerRef.current);
      const outerOk = outerRef ? shouldInterceptEscape(outerRef.current) : false;
      if (!innerOk && !outerOk) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setSelectedDiff(null);
    };
    // Capture phase ensures this fires before SessionViewer's bubble-phase listener
    // Clicking on non-focusable content (e.g. <pre> in the diff, the cwd breadcrumb)
    // moves document.activeElement to body in Chrome, breaking shouldInterceptEscape.
    // Re-focus the diff container whenever a click inside the diff body OR the outer
    // FileExplorer chrome drops focus to body.
    const restoreFocusDiff = (e: PointerEvent) => {
      const insideDiff = diffContainerRef.current?.contains(e.target as Node);
      const insideOuter = outerRef?.current?.contains(e.target as Node);
      if (!insideDiff && !insideOuter) return;
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) {
          diffContainerRef.current?.focus();
        }
      });
    };
    document.addEventListener("keydown", handler, true);
    document.addEventListener("pointerdown", restoreFocusDiff);
    return () => {
      document.removeEventListener("keydown", handler, true);
      document.removeEventListener("pointerdown", restoreFocusDiff);
    };
  }, [selectedDiff, outerRef]);

  const viewDiff = React.useCallback(async (filePath: string) => {
    setDiffLoading(true);
    try {
      const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/git-diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cwd, path: filePath }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as any;
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as any;
      setSelectedDiff({ path: filePath, diff: data.diff ?? "(no diff)" });
    } catch {
      setSelectedDiff({ path: filePath, diff: "(failed to load diff)" });
    } finally {
      setDiffLoading(false);
    }
  }, [runnerId, cwd]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner className="size-5" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <p className="text-sm text-red-400 mb-3">{error}</p>
        <Button variant="outline" size="sm" onClick={fetchStatus}>
          <RefreshCw className="size-3 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  if (!gitStatus) return null;

  if (selectedDiff) {
    return (
      <div ref={diffContainerRef} tabIndex={-1} className="flex flex-col h-full outline-none">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/50">
          <button
            type="button"
            onClick={() => setSelectedDiff(null)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Back to changes"
            aria-label="Back to changes"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="text-sm font-mono truncate flex-1">{selectedDiff.path}</span>
        </div>
        <div className="flex-1 overflow-auto">
          <pre className="p-3 text-xs font-mono leading-relaxed whitespace-pre-wrap break-all">
            {selectedDiff.diff.split("\n").map((line, i) => {
              let color = "text-muted-foreground";
              if (line.startsWith("+") && !line.startsWith("+++")) color = "text-green-600 dark:text-green-400";
              else if (line.startsWith("-") && !line.startsWith("---")) color = "text-red-600 dark:text-red-400";
              else if (line.startsWith("@@")) color = "text-blue-600 dark:text-blue-400";
              else if (line.startsWith("diff ") || line.startsWith("index ")) color = "text-muted-foreground/70";
              return (
                <div key={i} className={cn(color, "min-h-[1.25em]")}>
                  {line || "\u00A0"}
                </div>
              );
            })}
          </pre>
        </div>
      </div>
    );
  }

  const staged = gitStatus.changes.filter((c) => c.status.length === 2 && c.status[0] !== "?" && c.status[0] !== " " && c.status[0] !== "!");
  const unstaged = gitStatus.changes.filter((c) => c.status === "??" || (c.status.length === 2 && c.status[1] !== " "));
  const hasChanges = gitStatus.changes.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Branch header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/50">
        <GitBranch className="size-4 text-green-600 dark:text-green-400" />
        <span className="text-sm font-medium text-foreground">{gitStatus.branch || "detached"}</span>
        <div className="flex-1" />
        {gitStatus.ahead > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[0.65rem] text-green-600 dark:text-green-400" title={`${gitStatus.ahead} commit(s) ahead`}>
            <ArrowUp className="size-3" /> {gitStatus.ahead}
          </span>
        )}
        {gitStatus.behind > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[0.65rem] text-amber-500 dark:text-amber-400" title={`${gitStatus.behind} commit(s) behind`}>
            <ArrowDown className="size-3" /> {gitStatus.behind}
          </span>
        )}
        <button
          type="button"
          onClick={fetchStatus}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh git status"
          aria-label="Refresh git status"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {!hasChanges ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
            <GitCommit className="size-8 opacity-30" />
            <p className="text-sm">Working tree clean</p>
          </div>
        ) : (
          <div className="py-1">
            {/* Staged changes */}
            {staged.length > 0 && (
              <div className="mb-2">
                <div className="px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                  Staged Changes ({staged.length})
                </div>
                {staged.map((change) => {
                  const info = gitStatusLabel(change.status[0]);
                  return (
                    <button
                      key={`staged-${change.path}`}
                      type="button"
                      onClick={() => viewDiff(change.path)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-accent/60 transition-colors text-left"
                    >
                      <span className={cn("flex-shrink-0", info.color)} title={info.label}>{info.icon}</span>
                      <span className="truncate flex-1 font-mono text-xs text-foreground/80">{change.path}</span>
                      <span className={cn("text-[0.6rem] flex-shrink-0", info.color)}>{change.status[0]}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Unstaged/untracked changes */}
            {unstaged.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">
                  Changes ({unstaged.length})
                </div>
                {unstaged.map((change) => {
                  const displayStatus = change.status === "??" ? "??" : change.status.length === 2 ? change.status[1] : change.status;
                  const info = gitStatusLabel(displayStatus);
                  return (
                    <button
                      key={`unstaged-${change.path}`}
                      type="button"
                      onClick={() => viewDiff(change.path)}
                      disabled={change.status === "??"}
                      className={cn(
                        "flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-accent/60 transition-colors text-left",
                        change.status === "??" && "cursor-default hover:bg-transparent",
                      )}
                    >
                      <span className={cn("flex-shrink-0", info.color)} title={info.label}>{info.icon}</span>
                      <span className="truncate flex-1 font-mono text-xs text-foreground/80">{change.path}</span>
                      <span className={cn("text-[0.6rem] flex-shrink-0", info.color)}>{displayStatus}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {diffLoading && (
        <div className="flex items-center justify-center py-4 border-t border-border">
          <Spinner className="size-4" />
          <span className="text-xs text-muted-foreground ml-2">Loading diff…</span>
        </div>
      )}
    </div>
  );
}
