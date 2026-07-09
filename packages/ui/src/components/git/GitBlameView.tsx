/**
 * GitBlameView — per-line blame gutter for a file.
 *
 * Renders a GitHub-style blame table: line numbers, commit gutter, and
 * wrapped code. Consecutive lines from the same commit are grouped so the
 * gutter spans the whole block. Clicking a gutter block opens the diff for
 * that commit.
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

            <div className="flex-1 overflow-auto min-w-0">
                {groups.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
                        <FileText className="size-8 opacity-30" />
                        <p className="text-sm">No blame data</p>
                    </div>
                ) : (
                    <table className="w-full border-collapse text-xs min-w-[20rem]">
                        <tbody>
                            {groups.map((group) =>
                                blame.content
                                    .slice(group.start, group.start + group.count)
                                    .map((line, idx) => {
                                        const lineNumber = group.start + idx + 1;
                                        const isFirst = idx === 0;
                                        return (
                                            <tr
                                                key={`${group.hash}-${group.start}-${idx}`}
                                                className="border-b border-border/20 hover:bg-accent/10 transition-colors"
                                            >
                                                {isFirst && (
                                                    <td
                                                        rowSpan={group.count}
                                                        className="align-top p-0 border-r border-border/50 bg-muted/20 w-28 @sm:w-36 @md:w-44"
                                                    >
                                                        <button
                                                            type="button"
                                                            onClick={() => viewCommitDiff(group.hash)}
                                                            className="w-full h-full text-left px-2 py-1.5 hover:bg-accent/40 transition-colors group"
                                                            title={`${group.hash} — ${group.summary}`}
                                                        >
                                                            <span className="font-mono text-xs text-primary truncate block">
                                                                {group.hash}
                                                            </span>
                                                            <span className="text-[0.65rem] text-muted-foreground truncate block">
                                                                <User className="size-3 inline mr-0.5 align-text-bottom" />
                                                                {group.author}
                                                            </span>
                                                            <span className="text-[0.6rem] text-muted-foreground/70 truncate block">
                                                                <Clock className="size-3 inline mr-0.5 align-text-bottom" />
                                                                {formatRelativeDate(group.authorDate)}
                                                            </span>
                                                        </button>
                                                    </td>
                                                )}
                                                <td className="w-10 @sm:w-12 text-right text-muted-foreground/60 px-2 py-0.5 select-none align-top whitespace-nowrap">
                                                    {lineNumber}
                                                </td>
                                                <td className="px-2 py-0.5 align-top">
                                                    <pre className="font-mono whitespace-pre-wrap break-all text-foreground/90 leading-snug">
                                                        {line || "\u00A0"}
                                                    </pre>
                                                </td>
                                            </tr>
                                        );
                                    })
                            )}
                        </tbody>
                    </table>
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

interface ParsedDiffLine {
    type: "header" | "info" | "context" | "add" | "remove";
    oldLine: number | null;
    newLine: number | null;
    content: string;
}

interface ParsedDiff {
    filePath?: string;
    lines: ParsedDiffLine[];
}

function parseUnifiedDiff(diff: string): ParsedDiff {
    const lines: ParsedDiffLine[] = [];
    let oldLine = 0;
    let newLine = 0;
    let filePath: string | undefined;

    for (const rawLine of diff.split("\n")) {
        if (rawLine.startsWith("diff --git ")) {
            lines.push({ type: "header", oldLine: null, newLine: null, content: rawLine });
            continue;
        }
        if (rawLine.startsWith("index ")) {
            lines.push({ type: "info", oldLine: null, newLine: null, content: rawLine });
            continue;
        }
        if (rawLine.startsWith("--- ")) {
            filePath = rawLine.slice(4).replace(/^a\//, "");
            lines.push({ type: "info", oldLine: null, newLine: null, content: rawLine });
            continue;
        }
        if (rawLine.startsWith("+++ ")) {
            filePath = rawLine.slice(4).replace(/^b\//, "");
            lines.push({ type: "info", oldLine: null, newLine: null, content: rawLine });
            continue;
        }
        if (rawLine.startsWith("@@")) {
            const match = rawLine.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (match) {
                oldLine = parseInt(match[1], 10);
                newLine = parseInt(match[3], 10);
            }
            lines.push({ type: "info", oldLine: null, newLine: null, content: rawLine });
            continue;
        }
        if (rawLine.startsWith("+")) {
            lines.push({ type: "add", oldLine: null, newLine, content: rawLine });
            newLine++;
            continue;
        }
        if (rawLine.startsWith("-")) {
            lines.push({ type: "remove", oldLine, newLine: null, content: rawLine });
            oldLine++;
            continue;
        }
        lines.push({ type: "context", oldLine, newLine, content: rawLine });
        oldLine++;
        newLine++;
    }

    return { filePath, lines };
}

function GitDiffCode({ diff }: { diff: string }) {
    const { filePath, lines } = useMemo(() => parseUnifiedDiff(diff), [diff]);

    return (
        <div className="flex-1 overflow-auto min-w-0">
            <table className="w-full border-collapse text-xs font-mono min-w-[24rem]">
                <tbody>
                    {filePath && (
                        <tr className="border-b border-border bg-muted/30">
                            <td colSpan={3} className="px-3 py-1.5 text-sm truncate">
                                <FileText className="size-3.5 inline mr-1.5 align-text-bottom text-muted-foreground" />
                                {filePath}
                            </td>
                        </tr>
                    )}
                    {lines.map((line, i) => {
                        let rowClass = "text-muted-foreground";
                        let signClass = "text-muted-foreground/50";
                        if (line.type === "add") {
                            rowClass = "bg-green-500/10 text-green-700 dark:text-green-400";
                            signClass = "text-green-600 dark:text-green-400";
                        } else if (line.type === "remove") {
                            rowClass = "bg-red-500/10 text-red-700 dark:text-red-400";
                            signClass = "text-red-600 dark:text-red-400";
                        } else if (line.type === "info") {
                            rowClass = "text-blue-600 dark:text-blue-400 bg-blue-500/5";
                            signClass = "text-blue-600 dark:text-blue-400";
                        } else if (line.type === "header") {
                            rowClass = "text-muted-foreground/70";
                        }
                        return (
                            <tr key={i} className={cn(rowClass, "border-b border-border/10 hover:bg-accent/5")}>
                                <td className="w-10 @sm:w-12 text-right px-2 py-0.5 select-none text-muted-foreground/50 align-top whitespace-nowrap">
                                    {line.oldLine ?? ""}
                                </td>
                                <td className="w-10 @sm:w-12 text-right px-2 py-0.5 select-none text-muted-foreground/50 align-top whitespace-nowrap border-r border-border/30">
                                    {line.newLine ?? ""}
                                </td>
                                <td className="px-2 py-0.5 align-top">
                                    <pre className={cn("whitespace-pre-wrap break-all leading-snug", signClass)}>
                                        {line.content || "\u00A0"}
                                    </pre>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
