import { useState, useCallback, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Loader2, Sparkles } from "lucide-react";
import type { GitCommitSuggestion } from "@/hooks/useGitService";

interface GitCommitFormProps {
    hasStagedChanges: boolean;
    stagedCount: number;
    onCommit: (message: string) => void;
    /** Called when the user clicks Auto. Returns a suggested subject/body or null. */
    onSuggest?: () => Promise<GitCommitSuggestion | null>;
    isCommitting: boolean;
    suggesting?: boolean;
    disabled?: boolean;
}

/**
 * Commit composer pinned at the top of the Changes tab.
 *
 * Collapses to a single muted hint when nothing is staged, so it doesn't
 * compete with the file list during exploration. The Auto button fills a
 * conventional-commit message from the staged diff; the staged count sits
 * next to the Commit CTA.
 */
export function GitCommitForm({
    hasStagedChanges,
    stagedCount,
    onCommit,
    onSuggest,
    isCommitting,
    suggesting = false,
    disabled = false,
}: GitCommitFormProps) {
    const [message, setMessage] = useState("");
    const [suggestion, setSuggestion] = useState<GitCommitSuggestion | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const canCommit = hasStagedChanges && message.trim().length > 0 && !isCommitting && !disabled && !suggesting;

    const handleCommit = useCallback(() => {
        if (!canCommit) return;
        onCommit(message.trim());
        setMessage("");
        setSuggestion(null);
    }, [canCommit, message, onCommit]);

    const handleSuggest = useCallback(async () => {
        if (!onSuggest || suggesting || isCommitting) return;
        const result = await onSuggest();
        if (!result) return;
        setSuggestion(result);
        setMessage(result.subject + (result.body ? `\n\n${result.body}` : ""));
        if (typeof requestAnimationFrame !== "undefined") {
            requestAnimationFrame(() => {
                const el = textareaRef.current;
                if (el) el.focus();
            });
        }
    }, [onSuggest, suggesting, isCommitting]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleCommit();
            }
        },
        [handleCommit],
    );

    // Auto-resize textarea
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
    }, [message]);

    // Nothing staged → collapse to a single hint line.
    if (!hasStagedChanges) {
        return (
            <div className="border-t border-border bg-muted/20 px-3 py-2">
                <p className="text-xs text-muted-foreground/70">
                    Stage changes to enable committing
                </p>
            </div>
        );
    }

    return (
        <div className="border-t border-border bg-muted/20 px-3 py-2 space-y-2">
            <textarea
                ref={textareaRef}
                value={message}
                onChange={(e) => {
                    setMessage(e.target.value);
                    if (suggestion && e.target.value !== suggestion.subject + (suggestion.body ? `\n\n${suggestion.body}` : "")) {
                        setSuggestion(null);
                    }
                }}
                onKeyDown={handleKeyDown}
                placeholder="Describe your changes…"
                disabled={isCommitting || disabled}
                rows={1}
                className={cn(
                    "w-full resize-none rounded border border-border bg-background px-2 py-1.5",
                    "text-xs font-mono placeholder:text-muted-foreground/50",
                    "outline-none focus:ring-1 focus:ring-ring",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                    "min-h-[36px]",
                )}
            />
            <div className="flex flex-wrap items-center gap-2 justify-between">
                <button
                    type="button"
                    onClick={handleSuggest}
                    disabled={!onSuggest || suggesting || isCommitting || disabled}
                    className={cn(
                        "inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors",
                        "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                    )}
                    title="Auto-generate commit message from staged changes"
                >
                    {suggesting ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                    Auto
                </button>
                <span className="text-[0.65rem] text-muted-foreground">
                    {typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"}↵ to commit
                    {" · "}
                    <span className="text-green-600 dark:text-green-400">{stagedCount} staged</span>
                </span>
                <button
                    type="button"
                    onClick={handleCommit}
                    disabled={!canCommit}
                    className={cn(
                        "inline-flex items-center justify-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors min-h-9",
                        canCommit
                            ? "bg-primary text-primary-foreground hover:bg-primary/90"
                            : "bg-muted text-muted-foreground cursor-not-allowed",
                    )}
                >
                    {isCommitting && <Loader2 className="size-3 animate-spin" />}
                    Commit{stagedCount > 0 ? ` ${stagedCount}` : ""}
                </button>
            </div>
        </div>
    );
}
