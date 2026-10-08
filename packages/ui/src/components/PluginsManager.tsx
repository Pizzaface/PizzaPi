import * as React from "react";
import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { createLogger } from "@pizzapi/tools";
import { showToast } from "@/lib/frontend-log";
import {
    PluginsView,
    toPluginsViewData,
    type PluginInfo,
    type PluginsViewData,
    type PluginsViewSection,
} from "@/components/plugins/PluginsView";

export type { PluginInfo, PluginCommand } from "@/components/plugins/PluginsView";

const log = createLogger("plugins-ui");

export interface PluginsManagerProps {
    runnerId: string;
    /** Runner-cached plugin list — shown read-only until the live overview loads. */
    plugins: PluginInfo[];
    onPluginsChange?: (plugins: PluginInfo[]) => void;
    /** Claude plugins (default) or pi packages. */
    section?: PluginsViewSection;
}

/**
 * Runner-level Claude plugin / pi package management. Runs `/plugin` subcommands on the runner via
 * POST /api/runners/:id/plugins/command and renders the shared PluginsView.
 */
export function PluginsManager({ runnerId, plugins, onPluginsChange, section = "plugins" }: PluginsManagerProps) {
    const [data, setData] = React.useState<PluginsViewData | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [dirty, setDirty] = React.useState(false);
    const [reloading, setReloading] = React.useState(false);
    const onPluginsChangeRef = React.useRef(onPluginsChange);
    onPluginsChangeRef.current = onPluginsChange;

    const run = React.useCallback(async (args: string[]) => {
        setLoading(true);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/plugins/command`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ args }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                const message = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
                showToast(`Plugin command failed: ${message}`, "error");
                return;
            }
            const view = toPluginsViewData(body);
            setData(view);
            onPluginsChangeRef.current?.(view.overview.plugins);
            if (body?.changed === true) setDirty(true);
        } catch (err) {
            log.error("plugin command failed:", err);
            showToast("Couldn't reach the runner", "error");
        } finally {
            setLoading(false);
        }
    }, [runnerId]);

    React.useEffect(() => {
        setData(null);
        void run([]);
    }, [run]);

    const reloadSessions = async () => {
        setReloading(true);
        try {
            // Sends `/skills reload` to every live session, which re-reads
            // plugins along with skills and other resources.
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/skills/reload`, {
                method: "POST",
                credentials: "include",
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
            const n = typeof body.reloaded === "number" ? body.reloaded : 0;
            showToast(`Reloaded ${n} live session${n === 1 ? "" : "s"}`, "info");
            setDirty(false);
        } catch (err) {
            showToast(`Couldn't reload sessions: ${err instanceof Error ? err.message : String(err)}`, "error");
        } finally {
            setReloading(false);
        }
    };

    const view = data ?? toPluginsViewData({ overview: { plugins } });

    return (
        <>
            <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{section === "packages" ? "Pi Packages" : "Claude Plugins"}</h3>
                <div className="flex items-center gap-1">
                    {dirty && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={reloadSessions}
                            disabled={reloading}
                            title="Changes apply to new sessions; reload live sessions to pick them up now"
                        >
                            {reloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                            <span className="ml-1">Apply to live sessions</span>
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => void run([])}
                        disabled={loading}
                    >
                        {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                        <span className="ml-1">Rescan</span>
                    </Button>
                </div>
            </div>
            {!data && loading ? (
                <div role="status" aria-label="Loading from runner" className="flex flex-col gap-3 rounded-lg border border-border/40 p-3">
                    {[0, 1, 2].map((i) => (
                        <div key={i} className="flex flex-col gap-1.5">
                            <Skeleton className="h-3.5 w-40" />
                            <Skeleton className="h-3 w-3/4" />
                        </div>
                    ))}
                </div>
            ) : (
                <PluginsView
                    data={view}
                    onCommand={data ? run : undefined}
                    loading={loading}
                    sections={[section]}
                    className="rounded-lg border border-border/40"
                />
            )}
        </>
    );
}
