import { cn } from "@/lib/utils";
import { ChevronLeft } from "lucide-react";

interface GitDiffViewProps {
    path: string;
    diff: string;
    onClose: () => void;
}

export function GitDiffView({ path, diff, onClose }: GitDiffViewProps) {
    return (
        <div className="flex flex-col h-full outline-none">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/50">
                <button
                    type="button"
                    onClick={onClose}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="Back to changes"
                    aria-label="Back to changes"
                >
                    <ChevronLeft className="size-4" />
                </button>
                <span className="text-sm font-mono truncate flex-1">{path}</span>
            </div>
            <div className="flex-1 overflow-auto">
                <pre className="p-3 text-xs font-mono leading-relaxed whitespace-pre-wrap break-all">
                    {diff.split("\n").map((line, i) => {
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
