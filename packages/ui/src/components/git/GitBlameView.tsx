/**
 * GitBlameView — per-line blame gutter for a file.
 *
 * Groups consecutive lines that belong to the same commit and lets the user
 * view the diff for a clicked commit.
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useGitService, type GitBlameLine } from "@/hooks/useGitService";
import {
    ChevronLeft,
    Clock,
    FileText,
    User,
} from "lucide-react";

interface GitBlameViewProps {
    cwd: string;
    path: string;
    revision?: string;
    className?: string;
}

interface BlameGroup {
    hash: string;
    author: string;
    authorDate: string;
    summary: string;
    start: number;
    count: number;
}

export function GitBlameView({ cwd, path, revision, className }: GitBlameViewProps) {
    const git = useGitService(cwd);
    const [commitDiff, setCommitDiff] = useState<{ hash: string; diff: string } | null>(null);

    useEffect(() => {
        setCommitDiff(null);
        git.fetchBlame(path, revision);
    }, [cwd, path, revision]);

    const blame = git.blame;

    const groups = useMemo<BlameGroup[]>(() => {
        if (!blame) return [];
        const result: BlameGroup[] = [];
        for (let i = 0; i < blame.lines.length; i++) {
            const line = blame.lines[i];
            const prev = blame.lines[i - 1];
            if (i === 0 || line.hash !== prev.hash) {
                result.push({
                    hash: line.hash,
                    author: line.author,
                    authorDate: line.authorDate,
                    summary: line.summary,
                    start: i,
                    count: 1,
                });
            } else {
                result[result.length - 1].count++;
            }
        }
        return result;
    }, [blame]);

    const viewCommitDiff = async (hash: string) => {
        try {
            const result = await git.fetchDiffRevs(hash, `${hash}^`, path);
            setCommitDiff({ hash, diff: result });
        } catch {
            setCommitDiff({ hash, diff: "(failed to load diff)" });
        }
    };

    if (commitDiff) {
        return (
            <div className={cn("flex flex-col h-full overflow-hidden", className)}>
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/50 shrink-0">
                    <button
                        type="button"
                        onClick={() => setCommitDiff(null)}
                        className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                        aria-label="Back to blame"
                    >
                        <ChevronLeft className="size-4" />
                    </button>
                    <span className="text-sm font-mono truncate flex-1 min-w-0">
                        Commit {commitDiff.hash}
                    </span>
                </div>
                <GitDiffCode diff={commitDiff.diff} />
            </div>
        );
    }

    if (!blame) {
        return (
            <div className={cn("flex flex-col items-center justify-center py-8 text-muted-foreground gap-2", className)}>
                <Spinner className="size-5" />
                <p className="text-sm">Loading blame…</p>
            </div>
        );
    }

    return (
        <div className={cn("flex flex-col h-full overflow-hidden", className)}>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/50 shrink-0">
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-mono truncate flex-1 min-w-0">{path}</span>
                {revision && <Badge variant="outline">{revision}</Badge>}
            </div>

            <div className="flex-1 overflow-y-auto overflow-x-hidden">
                {groups.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
                        <FileText className="size-8 opacity-30" />
                        <p className="text-sm">No blame data</p>
                    </div>
                ) : (
                    groups.map((group) => (
                        <div
                            key={`${group.hash}-${group.start}`}
                            className="flex border-b border-border/30 hover:bg-accent/20 transition-colors"
                        >
                            <button
                                type="button"
                                onClick={() => viewCommitDiff(group.hash)}
                                className={cn(
                                    "flex flex-col justify-center px-2 py-1 text-left shrink-0",
                                    "border-r border-border/50 bg-muted/20 hover:bg-accent/40 transition-colors",
                                    "w-28 sm:w-40",
                                )}
                                title={`${group.hash} — ${group.summary}`}
                            >
                                <span className="font-mono text-xs text-primary truncate">
                                    {group.hash}
                                </span>
                                <span className="text-[0.65rem] text-muted-foreground truncate">
                                    <User className="size-3 inline mr-0.5 align-text-bottom" />
                                    {group.author}
                                </span>
                                <span className="text-[0.6rem] text-muted-foreground/70 truncate">
                                    <Clock className="size-3 inline mr-0.5 align-text-bottom" />
                                    {formatRelativeDate(group.authorDate)}
                                </span>
                            </button>
                            <div className="flex-1 min-w-0 overflow-x-auto">
                                {blame.content
                                    .slice(group.start, group.start + group.count)
                                    .map((line, idx) => (
                                        <pre
                                            key={idx}
                                            className="px-2 py-0.5 text-xs font-mono whitespace-pre min-w-full border-b border-border/20 last:border-b-0"
                                        >
                                            {line || "\u00A0"}
                                        </pre>
                                    ))}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
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
