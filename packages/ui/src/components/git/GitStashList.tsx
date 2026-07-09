/**
 * GitStashList — interactive stash manager.
 *
 * Lists stashes, supports push with an optional message + untracked flag,
 * and per-row pop / apply / drop (with confirmation).
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useGitService, type GitStashEntry } from "@/hooks/useGitService";
import { getGitOperationFeedback, type GitOperationFeedback } from "./git-operation-feedback";
import {
    AlertCircle,
    Archive,
    Check,
    CornerDownLeft,
    RotateCcw,
    Trash2,
} from "lucide-react";

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
    }, [cwd]);

    useEffect(() => {
        if (!git.lastOperationResult) {
            return;
        }
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
        // `git stash apply` keeps the entry by default; use Pop to remove it.
        git.stashApply(index);
    };

    const handleDrop = (index: number) => {
        if (isBusy) return;
        const confirmed = window.confirm(`Drop ${stashes[index]?.ref ?? `stash@{${index}}`}? This cannot be undone.`);
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
                    {feedback.type === "success" ? (
                        <Check className="size-3 shrink-0" />
                    ) : (
                        <AlertCircle className="size-3 shrink-0" />
                    )}
                    <span className="truncate flex-1 min-w-0">{feedback.message}</span>
                    <button
                        type="button"
                        onClick={() => setFeedback(null)}
                        className="text-current opacity-60 hover:opacity-100"
                        aria-label="Dismiss feedback"
                    >
                        ×
                    </button>
                </div>
            )}

            <form
                onSubmit={handlePush}
                className="flex flex-col @sm:flex-row items-start @sm:items-center gap-2 p-2 border-b border-border bg-muted/30"
            >
                <Input
                    placeholder="Stash message (optional)"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={isBusy}
                    className="flex-1 min-w-0"
                />
                <Label className="inline-flex items-center gap-2 text-sm text-foreground/80 shrink-0 whitespace-nowrap">
                    <input
                        type="checkbox"
                        checked={includeUntracked}
                        onChange={(e) => setIncludeUntracked(e.target.checked)}
                        disabled={isBusy}
                        className="size-4 rounded border border-input text-primary accent-primary focus:ring-2 focus:ring-ring"
                    />
                    Include untracked
                </Label>
                <Button
                    type="submit"
                    disabled={isBusy}
                    size="sm"
                    className="w-full @sm:w-auto h-9"
                >
                    {isBusy ? <Spinner className="size-4" /> : <Archive className="size-4" />}
                    <span className="ml-1.5">Push</span>
                </Button>
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
                            <div
                                key={stash.index}
                                className="flex flex-col @sm:flex-row @sm:items-center gap-2 px-3 py-2"
                            >
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                    <span className="font-mono text-xs text-muted-foreground shrink-0">
                                        {stash.ref}
                                    </span>
                                    <span className="truncate text-sm font-medium">{stash.message}</span>
                                </div>
                                <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0 min-w-0">
                                    <span className="font-mono shrink-0">{stash.shortHash}</span>
                                    <span className="truncate">{stash.date}</span>
                                </div>
                                <div className="flex flex-col @sm:flex-row gap-2 w-full @sm:w-auto">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={isBusy}
                                        onClick={() => handlePop(stash.index)}
                                        className="w-full @sm:w-auto h-9"
                                    >
                                        <RotateCcw className="size-3.5" />
                                        <span className="ml-1.5">Pop</span>
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={isBusy}
                                        onClick={() => handleApply(stash.index)}
                                        className="w-full @sm:w-auto h-9"
                                    >
                                        <CornerDownLeft className="size-3.5" />
                                        <span className="ml-1.5">Apply</span>
                                    </Button>
                                    <Button
                                        variant="destructive"
                                        size="sm"
                                        disabled={isBusy}
                                        onClick={() => handleDrop(stash.index)}
                                        className="w-full @sm:w-auto h-9"
                                    >
                                        <Trash2 className="size-3.5" />
                                        <span className="ml-1.5">Drop</span>
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
