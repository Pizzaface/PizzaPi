import { cn } from "@/lib/utils";
import { Plus, Minus, Edit3, FileQuestion, File, HelpCircle } from "lucide-react";

/** Whether a porcelain status string means the file is staged (index status set). */
export function isStagedChange(status: string): boolean {
    if (status === "??" || status === "!!") return false;
    const c = status[0];
    return c !== " " && c !== "?" && c !== "!";
}

function statusLetter(status: string, staged: boolean): string {
    if (status === "??") return "?";
    if (staged) return status[0];
    if (status.length === 2 && status[1] !== " ") return status[1];
    return status[0];
}

/**
 * Status icon for a git change. Colors follow the source-control convention:
 * M amber, A green, D red, untracked muted.
 */
export function GitStatusIcon({ status, staged, className }: { status: string; staged: boolean; className?: string }) {
    const letter = statusLetter(status, staged);
    const icon = (() => {
        switch (letter) {
            case "M": return <Edit3 className="text-amber-500 dark:text-amber-400" />;
            case "A": return <Plus className="text-green-600 dark:text-green-400" />;
            case "D": return <Minus className="text-red-500 dark:text-red-400" />;
            case "?": return <FileQuestion className="text-muted-foreground" />;
            case "!": return <HelpCircle className="text-muted-foreground/60" />;
            default: return <File className="text-muted-foreground" />;
        }
    })();
    return <span className={cn("shrink-0", className)}>{icon}</span>;
}
