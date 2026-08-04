/**
 * GitStashList — interactive stash manager.
 *
 * Compact cards: message + ref/date on one row, actions (Pop / Apply / Drop)
 * behind a ⋯ menu to keep the 320px panel readable. Create-stash composer on top.
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGitService, type GitStashEntry } from "@/hooks/useGitService";
import { getGitOperationFeedback, type GitOperationFeedback } from "./git-operation-feedback";
import { AlertCircle, Archive, Check, CornerDownLeft, RotateCcw, Trash2, MoreHorizontal, Box } from "lucide-react";

interface GitStashListProps {
    cwd: string;
    className?: string;
}

export function GitStashList({ cwd, className }: GitStashListProps) {
    const git = useGitService(cwd);
    const [message, setMessage] = useState("");
    const [includeUntracked, setIncludeUntracked] = useState(false);
    const [feedback, setFeedback] = useState<GitOperationFeedback | null>(null);

    useEffect(() => {
        git.stashList();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cwd]);

    useEffect(() => {
        if (!git.lastOperationResult) return;
        setFeedback(getGitOperationFeedback(git.lastOperationResult));
        const timer = setTimeout(() => setFeedback(null), 5000);
        return () => clearTimeout(timer);
    }, [git.lastOperationResult]);

    const isBusy = git.operationInProgress !== null;
    const stashes = git.stashes ?? [];

    const handlePush = (e: React.FormEvent) => {
        e.preventDefault();
        if (isBusy) return;
        git.stashPush(message || undefined, includeUntracked);
        setMessage("");
        setIncludeUntracked(false);
    };

    const handlePop = (index: number) => {
        if (isBusy) return;
        git.stashPop(index);
    };

    const handleApply = (index: number) => {
        if (isBusy) return;
        git.stashApply(index);
    };

    const handleDrop = (index: number) => {
        if (isBusy) return;
        const entry = stashes[index];
        const confirmed = window.confirm(`Drop ${entry?.ref ?? `stash@{${index}}`}? This cannot be undone.`);
        if (!confirmed) return;
        git.stashDrop(index);
    };

    return (
        <div className={cn("flex flex-col h-full overflow-hidden", className)}>
            {feedback && (
                <div
                    className={cn(
                        "flex items-center gap-2 px-3 py-1.5 text-xs border-b",
                        feedback.type === "success"
                            ? "bg-green-600/10 border-green-600/20 text-green-600 dark:text-green-400"
                            : "bg-red-500/10 border-red-500/20 text-red-500 dark:text-red-400",
                    )}
                >
                    {feedback.type === "success" ? <Check className="size-3 shrink-0" /> : <AlertCircle className="size-3 shrink-0" />}
                    <span className="truncate flex-1 min-w-0">{feedback.message}</span>
                    <button type="button" onClick={() => setFeedback(null)} className="text-current opacity-60 hover:opacity-100" aria-label="Dismiss feedback">×</button>
                </div>
            )}

            {/* Create-stash composer */}
            <form onSubmit={handlePush} className="flex flex-col gap-2 p-2 border-b border-border bg-muted/30">
                <Input
                    placeholder="Stash message (optional)"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={isBusy}
                    className="flex-1 min-w-0"
                />
                <div className="flex items-center gap-2">
                    <Label className="inline-flex items-center gap-1.5 text-xs text-foreground/80 shrink-0 whitespace-nowrap">
                        <input
                            type="checkbox"
                            checked={includeUntracked}
                            onChange={(e) => setIncludeUntracked(e.target.checked)}
                            disabled={isBusy}
                            className="size-4 rounded border border-input text-primary accent-primary focus:ring-2 focus:ring-ring"
                        />
                        Include untracked
                    </Label>
                    <div className="flex-1" />
                    <button
                        type="submit"
                        disabled={isBusy}
                        className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 min-h-9"
                    >
                        {isBusy ? <Spinner className="size-4" /> : <Box className="size-3.5" />}
                        Stash changes
                    </button>
                </div>
            </form>

            <div className="flex-1 overflow-y-auto overflow-x-hidden">
                {stashes.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
                        <Archive className="size-8 opacity-30" />
                        <p className="text-sm">No stashes</p>
                    </div>
                ) : (
                    <div className="divide-y divide-border/50">
                        {stashes.map((stash) => (
                            <StashCard key={stash.index} stash={stash} isBusy={isBusy} onPop={handlePop} onApply={handleApply} onDrop={handleDrop} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function StashCard({
    stash,
    isBusy,
    onPop,
    onApply,
    onDrop,
}: {
    stash: GitStashEntry;
    isBusy: boolean;
    onPop: (index: number) => void;
    onApply: (index: number) => void;
    onDrop: (index: number) => void;
}) {
    return (
        <div className="flex items-center gap-2 px-3 py-2 hover:bg-accent/30 transition-colors">
            <Archive className="size-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="truncate text-sm text-foreground/90">{stash.message || "(no message)"}</div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-mono">{stash.ref}</span>
                    {stash.shortHash && <><span>·</span><span className="font-mono">{stash.shortHash}</span></>}
                    <span>·</span>
                    <span>{formatRelativeDate(stash.date)}</span>
                </div>
            </div>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        disabled={isBusy}
                        className="flex-shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50"
                        title={`Actions for ${stash.ref}`}
                        aria-label={`Actions for ${stash.ref}`}
                    >
                        <MoreHorizontal className="size-3.5" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onSelect={() => onPop(stash.index)} disabled={isBusy}>
                        <RotateCcw className="size-3.5" /> Pop
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onApply(stash.index)} disabled={isBusy}>
                        <CornerDownLeft className="size-3.5" /> Apply
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => onDrop(stash.index)} disabled={isBusy}>
                        <Trash2 className="size-3.5" /> Drop
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

function formatRelativeDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return "just now";
    const units: [Intl.RelativeTimeFormatUnit, number][] = [
        ["year", 31536000], ["month", 2592000], ["week", 604800],
        ["day", 86400], ["hour", 3600], ["minute", 60],
    ];
    for (const [unit, threshold] of units) {
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
