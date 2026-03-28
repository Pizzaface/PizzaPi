import { useState, useCallback, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

interface GitCommitFormProps {
    hasStagedChanges: boolean;
    onCommit: (message: string) => void;
    isCommitting: boolean;
}

export function GitCommitForm({ hasStagedChanges, onCommit, isCommitting }: GitCommitFormProps) {
    const [message, setMessage] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const canCommit = hasStagedChanges && message.trim().length > 0 && !isCommitting;

    const handleCommit = useCallback(() => {
        if (!canCommit) return;
        onCommit(message.trim());
        setMessage("");
    }, [canCommit, message, onCommit]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            // Cmd/Ctrl+Enter to commit
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
        el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }, [message]);

    return (
        <div className="border-t border-border bg-muted/20 px-3 py-2 space-y-2">
            <textarea
                ref={textareaRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={hasStagedChanges ? "Commit message…" : "Stage changes to commit"}
                disabled={!hasStagedChanges || isCommitting}
                rows={1}
                className={cn(
                    "w-full resize-none rounded border border-border bg-background px-2 py-1.5",
                    "text-xs font-mono placeholder:text-muted-foreground/50",
                    "outline-none focus:ring-1 focus:ring-ring",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                    "min-h-[32px]",
                )}
            />
            <div className="flex items-center justify-between">
                <span className="text-[0.6rem] text-muted-foreground">
                    {hasStagedChanges ? "⌘↵ to commit" : ""}
                </span>
                <button
                    type="button"
                    onClick={handleCommit}
                    disabled={!canCommit}
                    className={cn(
                        "inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors",
                        canCommit
                            ? "bg-primary text-primary-foreground hover:bg-primary/90"
                            : "bg-muted text-muted-foreground cursor-not-allowed",
                    )}
                >
                    {isCommitting && <Loader2 className="size-3 animate-spin" />}
                    Commit
                </button>
            </div>
        </div>
    );
}
