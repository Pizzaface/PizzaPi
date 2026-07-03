/**
 * In-app frontend error log viewer.
 *
 * A subtle affordance (appears only once something has been logged) that opens
 * a scrollable panel of captured errors/warnings/info — including uncaught
 * errors and unhandled rejections — so failures can be troubleshooted from the
 * device without a debugger. Copy-all + clear included.
 */
import { useSyncExternalStore, useState } from "react";
import { AlertTriangle, X, Copy, Trash2 } from "lucide-react";
import { subscribeFrontendLog, getFrontendLog, clearFrontendLog, type FrontendLogEntry } from "@/lib/frontend-log";
import { getMobileRuntimeConfig } from "@/lib/mobile-runtime";

function useFrontendLog(): FrontendLogEntry[] {
    return useSyncExternalStore(subscribeFrontendLog, getFrontendLog, getFrontendLog);
}

function formatEntry(e: FrontendLogEntry): string {
    const t = new Date(e.ts).toISOString();
    return `${t} [${e.level}] [${e.scope}] ${e.message}${e.detail ? `\n    ${e.detail}` : ""}`;
}

export function FrontendLogOverlay() {
    const entries = useFrontendLog();
    const [open, setOpen] = useState(false);
    // Always offer the affordance in the mobile app — a stuck/blank screen has
    // nothing else to tap. On web, stay hidden until something is logged.
    const { isMobileBundled } = getMobileRuntimeConfig();

    if (entries.length === 0 && !isMobileBundled) return null;

    const errorCount = entries.filter((e) => e.level === "error").length;

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="fixed bottom-3 left-3 z-[60] inline-flex items-center gap-1 rounded-full border border-border bg-background/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
                title="Open frontend log"
            >
                <AlertTriangle size={12} className={errorCount ? "text-destructive" : ""} />
                Logs {errorCount ? `(${errorCount})` : `(${entries.length})`}
            </button>
        );
    }

    const copyAll = () => {
        void navigator.clipboard?.writeText(entries.map(formatEntry).join("\n"));
    };

    return (
        <div className="fixed bottom-3 left-3 z-[60] flex max-h-[60vh] w-[min(92vw,520px)] flex-col rounded-lg border border-border bg-background shadow-xl">
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                <AlertTriangle size={13} className={errorCount ? "text-destructive" : "text-muted-foreground"} />
                <span className="text-xs font-medium">Frontend log ({entries.length})</span>
                <div className="flex-1" />
                <button type="button" onClick={copyAll} title="Copy all" className="p-1 text-muted-foreground hover:text-foreground">
                    <Copy size={13} />
                </button>
                <button type="button" onClick={clearFrontendLog} title="Clear" className="p-1 text-muted-foreground hover:text-foreground">
                    <Trash2 size={13} />
                </button>
                <button type="button" onClick={() => setOpen(false)} title="Close" className="p-1 text-muted-foreground hover:text-foreground">
                    <X size={13} />
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px] leading-snug">
                {[...entries].reverse().map((e) => (
                    <div
                        key={e.id}
                        className={`border-b border-border/40 py-1 ${e.level === "error" ? "text-destructive" : e.level === "warning" ? "text-yellow-500" : "text-muted-foreground"}`}
                    >
                        <span className="opacity-60">{new Date(e.ts).toLocaleTimeString()} </span>
                        <span className="opacity-80">[{e.scope}]</span> {e.message}
                        {e.detail && <div className="whitespace-pre-wrap break-all pl-4 opacity-70">{e.detail}</div>}
                    </div>
                ))}
            </div>
        </div>
    );
}
