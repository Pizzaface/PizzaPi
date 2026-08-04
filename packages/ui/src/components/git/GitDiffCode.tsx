import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

/**
 * Renders unified diff text with correct source-control colors:
 * additions green, removals red, hunk headers blue, metadata muted.
 */
export function GitDiffCode({ diff, loading = false, className }: { diff: string; loading?: boolean; className?: string }) {
    if (loading) {
        return (
            <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
                <Spinner className="size-4" />
                <span className="text-xs">Loading diff…</span>
            </div>
        );
    }

    return (
        <div className={cn("min-w-0 overflow-auto", className)}>
            <pre className="p-3 text-xs font-mono leading-relaxed whitespace-pre min-w-full">
                {diff.split("\n").map((line, i) => {
                    let color = "text-muted-foreground";
                    if (line.startsWith("+") && !line.startsWith("+++")) color = "text-green-600 dark:text-green-400";
                    else if (line.startsWith("-") && !line.startsWith("---")) color = "text-red-600 dark:text-red-400";
                    else if (line.startsWith("@@")) color = "text-blue-600 dark:text-blue-400";
                    else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file")) color = "text-muted-foreground/70";
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
