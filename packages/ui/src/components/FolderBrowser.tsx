/**
 * FolderBrowser — inline directory navigator for the new-session wizard.
 *
 * Fetches subdirectories from the runner via REST and lets the user
 * click through the filesystem to pick a working directory.
 */
import * as React from "react";
import { Folder, FolderOpen, ChevronRight, Loader2, AlertCircle, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface FolderBrowserProps {
    runnerId: string;
    /** Called when the user selects (confirms) a directory. */
    onSelect: (path: string) => void;
    /** Called when user clicks "Cancel" to go back to recent projects. */
    onCancel: () => void;
    /** Initial path to browse from. */
    initialPath?: string;
    disabled?: boolean;
}

interface DirEntry {
    name: string;
    path: string;
}

export function FolderBrowser({
    runnerId,
    onSelect,
    onCancel,
    initialPath = "/",
    disabled = false,
}: FolderBrowserProps) {
    const [currentPath, setCurrentPath] = React.useState(initialPath);
    const [directories, setDirectories] = React.useState<DirEntry[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const listRef = React.useRef<HTMLDivElement>(null);

    // Fetch directories whenever currentPath changes
    React.useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);

        fetch(
            `/api/runners/${encodeURIComponent(runnerId)}/browse?path=${encodeURIComponent(currentPath)}`,
            { credentials: "include" },
        )
            .then((res) => {
                if (!res.ok) return res.json().then((b) => { throw new Error(b.error || `HTTP ${res.status}`); });
                return res.json();
            })
            .then((body: any) => {
                if (cancelled) return;
                setDirectories(Array.isArray(body?.directories) ? body.directories : []);
            })
            .catch((err) => {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : "Failed to browse directory");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => { cancelled = true; };
    }, [runnerId, currentPath]);

    // Scroll to top when navigating
    React.useEffect(() => {
        listRef.current?.scrollTo(0, 0);
    }, [currentPath]);

    function navigateTo(path: string) {
        if (!disabled) setCurrentPath(path);
    }

    function navigateUp() {
        if (currentPath === "/") return;
        const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
        navigateTo(parent);
    }

    // Build breadcrumb segments
    const segments = React.useMemo(() => {
        const parts = currentPath.split("/").filter(Boolean);
        const result: { label: string; path: string }[] = [{ label: "/", path: "/" }];
        let acc = "";
        for (const part of parts) {
            acc += "/" + part;
            result.push({ label: part, path: acc });
        }
        return result;
    }, [currentPath]);

    return (
        <div className="flex flex-col gap-2">
            {/* Breadcrumb navigation */}
            <div className="flex items-center gap-1 text-xs text-muted-foreground overflow-x-auto min-h-[24px] flex-shrink-0">
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 flex-shrink-0"
                    onClick={navigateUp}
                    disabled={disabled || currentPath === "/"}
                    title="Go up"
                >
                    <ArrowUp className="h-3 w-3" />
                </Button>
                {segments.map((seg, i) => (
                    <React.Fragment key={seg.path}>
                        {i > 0 && <ChevronRight className="h-3 w-3 flex-shrink-0 opacity-40" />}
                        <button
                            type="button"
                            onClick={() => navigateTo(seg.path)}
                            disabled={disabled}
                            className={cn(
                                "font-mono hover:text-foreground transition-colors whitespace-nowrap",
                                i === segments.length - 1 ? "text-foreground font-medium" : "",
                            )}
                        >
                            {seg.label}
                        </button>
                    </React.Fragment>
                ))}
            </div>

            {/* Directory listing */}
            <div
                ref={listRef}
                className="rounded-md border border-border overflow-y-auto"
                style={{ maxHeight: 280 }}
            >
                {loading && (
                    <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading…
                    </div>
                )}

                {!loading && error && (
                    <div className="flex items-center gap-2 px-3 py-4 text-sm text-destructive">
                        <AlertCircle className="h-4 w-4 flex-shrink-0" />
                        {error}
                    </div>
                )}

                {!loading && !error && directories.length === 0 && (
                    <p className="px-3 py-4 text-xs text-muted-foreground text-center">
                        No subdirectories
                    </p>
                )}

                {!loading && !error && directories.length > 0 && (
                    <div className="flex flex-col">
                        {directories.map((dir) => (
                            <button
                                key={dir.path}
                                type="button"
                                onClick={() => navigateTo(dir.path)}
                                disabled={disabled}
                                className={cn(
                                    "flex items-center gap-2 px-3 py-2 text-left text-sm",
                                    "hover:bg-muted transition-colors",
                                )}
                            >
                                <Folder className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                                <span className="font-mono truncate">{dir.name}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onCancel}
                    disabled={disabled}
                >
                    Back to recent
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onSelect(currentPath)}
                    disabled={disabled}
                >
                    <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                    Select this folder
                </Button>
            </div>
        </div>
    );
}
