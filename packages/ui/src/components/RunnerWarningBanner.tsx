import * as React from "react";
import { X } from "lucide-react";
import type { RunnerInfo } from "@pizzapi/protocol";

/**
 * Dismissable amber banner shown when any connected runner has active warnings
 * (e.g. tunnel connection failures, version mismatches).
 *
 * Automatically clears when the runner removes the warning. Dismissible per-session
 * — dismissing hides the banner until a new (different) warning arrives.
 */
export function RunnerWarningBanner({ runners }: { runners: RunnerInfo[] }) {
    // Collect all warnings across all runners, tagged with runner name
    const allWarnings = React.useMemo(() => {
        const result: Array<{ runner: string; message: string; key: string }> = [];
        for (const r of runners) {
            if (!r.warnings?.length) continue;
            const name = r.name ?? r.runnerId.slice(0, 8);
            for (const msg of r.warnings) {
                result.push({ runner: name, message: msg, key: `${r.runnerId}:${msg}` });
            }
        }
        return result;
    }, [runners]);

    // Track which warning keys have been dismissed
    const [dismissed, setDismissed] = React.useState<Set<string>>(new Set());

    // When warnings change, un-dismiss any that are no longer present (so if
    // the same warning comes back later, it shows again)
    const prevKeysRef = React.useRef<Set<string>>(new Set());
    React.useEffect(() => {
        const currentKeys = new Set(allWarnings.map((w) => w.key));
        const removed = [...prevKeysRef.current].filter((k) => !currentKeys.has(k));
        if (removed.length > 0) {
            setDismissed((prev) => {
                const next = new Set(prev);
                for (const k of removed) next.delete(k);
                return next.size !== prev.size ? next : prev;
            });
        }
        prevKeysRef.current = currentKeys;
    }, [allWarnings]);

    const visible = allWarnings.filter((w) => !dismissed.has(w.key));
    if (visible.length === 0) return null;

    return (
        <>
            {visible.map((w) => (
                <div
                    key={w.key}
                    role="alert"
                    className="flex items-center justify-between gap-3 px-4 py-2 text-sm bg-amber-500/10 text-amber-600 dark:text-amber-400 border-b border-amber-500/20"
                >
                    <span>
                        <span aria-hidden="true">⚠️</span>{" "}
                        <span className="font-medium">{w.runner}:</span>{" "}
                        {w.message}
                    </span>
                    <button
                        type="button"
                        aria-label="Dismiss warning"
                        onClick={() =>
                            setDismissed((prev) => new Set(prev).add(w.key))
                        }
                        className="shrink-0 rounded p-0.5 hover:bg-amber-500/20 transition-colors"
                    >
                        <X className="size-4" />
                    </button>
                </div>
            ))}
        </>
    );
}
