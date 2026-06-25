/**
 * GitHistoryView — repo or file history browser.
 *
 * Displays a list of GitLogEntry rows. Click a row to diff that commit
 * against its parent, or select two commits and diff them.
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useGitService, type GitLogEntry } from "@/hooks/useGitService";
import {
    ChevronLeft,
    Clock,
    Diff,
    GitCommit,
    User,
} from "lucide-react";

interface GitHistoryViewProps {
    cwd: string;
    path?: string;
    className?: string;
}

export function GitHistoryView({ cwd, path, className }: GitHistoryViewProps) {
    const git = useGitService(cwd);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [diff, setDiff] = useState<{ title: string; diff: string } | null>(null);
    const [loading, setLoading] = useState(false);

    const log = git.log ?? [];

    useEffect(() => {
        setSelected(new Set());
        setDiff(null);
        git.fetchLog(path);
    }, [cwd, path]);

    const toggleSelection = (hash: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(hash)) {
                next.delete(hash);
            } else if (next.size < 2) {
                next.add(hash);
            } else {
                // Keep the most-recently-selected two: replace the older one.
                const values = Array.from(next);
                next.delete(values[0]);
                next.add(hash);
            }
            return next;
        });
    };

    const viewCommitDiff = async (entry: GitLogEntry) => {
        if (loading) return;
        setLoading(true);
        try {
            const result = await git.fetchDiffRevs(entry.hash, `${entry.hash}^`, path);
            setDiff({ title: `${entry.shortHash} — ${entry.subject}`, diff: result });
        } catch {
            setDiff({ title: "Error", diff: "(failed to load diff)" });
        } finally {
            setLoading(false);
        }
    };

    const viewSelectedDiff = async () => {
        if (selected.size !== 2 || loading) return;
        const [base, head] = Array.from(selected);
        setLoading(true);
        try {
            const result = await git.fetchDiffRevs(base, head, path);
            setDiff({
                title: `Diff ${short(base)}..${short(head)}`,
                diff: result,
            });
        } catch {
            setDiff({ title: "Error", diff: "(failed to load diff)" });
        } finally {
            setLoading(false);
        }
    };

    if (diff) {
        return (
            <div className={cn("flex flex-col h-full overflow-hidden", className)}>
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/50 shrink-0">
                    <button
                        type="button"
                        onClick={() => setDiff(null)}
                        className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                        aria-label="Back to history"
                    >
                        <ChevronLeft className="size-4" />
                    </button>
                    <span className="text-sm font-medium truncate flex-1 min-w-0">{diff.title}</span>
                </div>
                <GitDiffCode diff={diff.diff} />
            </div>
        );
    }

    return (
        <div className={cn("flex flex-col h-full overflow-hidden", className)}>
            {selected.size === 2 && (
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 p-2 border-b border-border bg-muted/30 shrink-0">
                    <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                        Diff {short(Array.from(selected)[0])} ↔ {short(Array.from(selected)[1])}
                    </span>
                    <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                        <Button
                            size="sm"
                            disabled={loading}
                            onClick={viewSelectedDiff}
                            className="w-full sm:w-auto h-9"
                        >
                            <Diff className="size-3.5" />
                            <span className="ml-1.5">View diff</span>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setSelected(new Set())}
                            className="w-full sm:w-auto h-9"
                        >
                            Clear
                        </Button>
                    </div>
                </div>
            )}

            <div className="flex-1 overflow-y-auto overflow-x-hidden">
                {log.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
                        <GitCommit className="size-8 opacity-30" />
                        <p className="text-sm">
                            {path ? `No history for ${path}` : "No commits found"}
                        </p>
                    </div>
                ) : (
                    <div className="divide-y divide-border/50">
                        {log.map((entry) => (
                            <div
                                key={entry.hash}
                                className="flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2 hover:bg-accent/30 transition-colors"
                            >
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                    <input
                                        type="checkbox"
                                        checked={selected.has(entry.hash)}
                                        onChange={() => toggleSelection(entry.hash)}
                                        className="size-4 shrink-0 rounded border border-input text-primary accent-primary focus:ring-2 focus:ring-ring"
                                        aria-label={`Select ${entry.shortHash} for diff`}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => viewCommitDiff(entry)}
                                        className="flex-1 min-w-0 text-left"
                                    >
                                        <div className="truncate text-sm font-medium">
                                            {entry.subject}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                                            <span className="inline-flex items-center gap-1 font-mono">
                                                {entry.shortHash}
                                            </span>
                                            <span className="inline-flex items-center gap-1">
                                                <User className="size-3" />
                                                {entry.author}
                                            </span>
                                            <span className="inline-flex items-center gap-1">
                                                <Clock className="size-3" />
                                                {formatRelativeDate(entry.authorDate)}
                                            </span>
                                        </div>
                                    </button>
                                </div>
                                {entry.refs.length > 0 && (
                                    <div className="flex flex-wrap gap-1 items-center shrink-0 pl-6 sm:pl-0">
                                        {entry.refs.map((ref) => (
                                            <Badge key={ref} variant="secondary" className="text-[0.65rem]">
                                                {ref}
                                            </Badge>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function short(hash: string): string {
    return hash.slice(0, 7);
}

function formatRelativeDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;

    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    const units: { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
        { unit: "year", seconds: 31536000 },
        { unit: "month", seconds: 2592000 },
        { unit: "week", seconds: 604800 },
        { unit: "day", seconds: 86400 },
        { unit: "hour", seconds: 3600 },
        { unit: "minute", seconds: 60 },
    ];

    if (seconds < 60) return "just now";
    for (const { unit, seconds: threshold } of units) {
        const value = Math.floor(seconds / threshold);
        if (value >= 1) {
            try {
                return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-value, unit);
            } catch {
                return `${value} ${unit}${value > 1 ? "s" : ""} ago`;
            }
        }
    }
    return iso;
}

function GitDiffCode({ diff }: { diff: string }) {
    return (
        <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">
            <pre className="p-3 text-xs font-mono leading-relaxed whitespace-pre overflow-x-auto min-w-full">
                {diff.split("\n").map((line, i) => {
                    let color = "text-muted-foreground";
                    if (line.startsWith("+") && !line.startsWith("+++")) {
                        color = "text-green-600 dark:text-green-400";
                    } else if (line.startsWith("-") && !line.startsWith("---")) {
                        color = "text-red-600 dark:text-red-400";
                    } else if (line.startsWith("@@")) {
                        color = "text-blue-600 dark:text-blue-400";
                    } else if (line.startsWith("diff ") || line.startsWith("index ")) {
                        color = "text-muted-foreground/70";
                    }
                    return (
                        <div key={i} className={cn(color, "min-h-[1.25em]")}>
                            {line || "\u00A0"}
                        </div>
                    );
                })}
            </pre>
        </div>
    );
}
