/**
 * NewSessionWizardDialog — shared wizard for spawning a new session.
 *
 * Two modes:
 *  - "global"      → Step 1: pick runner, Step 2: pick folder
 *  - "preselected" → starts directly at Step 2 (runner already chosen)
 */
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FolderOpen, Loader2, X, ChevronLeft, Monitor } from "lucide-react";
import { SiApple, SiLinux } from "react-icons/si";
import { cn } from "@/lib/utils";
import { formatPathTail } from "@/lib/path";
import { filterFolders } from "@/lib/filterFolders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";

// ── Types ──────────────────────────────────────────────────────────────────

export interface WizardRunner {
    runnerId: string;
    name: string | null;
    sessionCount: number;
    roots?: string[];
    isOnline: boolean;
    /** Node.js process.platform from the runner (e.g. "darwin", "linux", "win32") */
    platform?: string | null;
}

export interface NewSessionWizardDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;

    /** All connected runners to display in Step 1. */
    runners: WizardRunner[];
    runnersLoading?: boolean;

    /**
     * When set, skip Step 1 and use this runner directly.
     * Pass `null` / `undefined` for the global (pick-a-runner) mode.
     */
    preselectedRunnerId?: string | null;

    /**
     * Optional initial cwd (e.g. when duplicating a session).
     */
    initialCwd?: string;

    /**
     * Called when the user clicks "Start Session".
     * `cwd` is `undefined` when the field is blank.
     */
    onSpawn: (runnerId: string, cwd: string | undefined) => Promise<void>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const ROW_HEIGHT = 36;
const OVERSCAN = 8;
const LIST_MAX_HEIGHT = 360;

// ── Helpers ────────────────────────────────────────────────────────────────

function runnerLabel(r: WizardRunner): string {
    return r.name?.trim() || `${r.runnerId.slice(0, 8)}…`;
}

function PlatformIcon({ platform }: { platform: string | null | undefined }) {
    const cls = "h-3.5 w-3.5 flex-shrink-0";
    switch (platform) {
        case "darwin":  return <SiApple className={cls} />;
        case "linux":   return <SiLinux className={cls} />;
        case "win32":   return <Monitor className={cls} />;
        default:        return platform ? <Monitor className={cls} /> : null;
    }
}

function platformName(platform: string | null | undefined): string | null {
    if (!platform) return null;
    switch (platform) {
        case "darwin":  return "macOS";
        case "linux":   return "Linux";
        case "win32":   return "Windows";
        default:        return platform;
    }
}

// ── Component ──────────────────────────────────────────────────────────────

export function NewSessionWizardDialog({
    open,
    onOpenChange,
    runners,
    runnersLoading,
    preselectedRunnerId,
    initialCwd,
    onSpawn,
}: NewSessionWizardDialogProps) {
    const isPreselected = preselectedRunnerId != null;

    // Step: "runner" | "folder"
    const [step, setStep] = React.useState<"runner" | "folder">(
        isPreselected ? "folder" : "runner",
    );
    const [selectedRunnerId, setSelectedRunnerId] = React.useState<string | null>(
        preselectedRunnerId ?? null,
    );
    const selectedRunnerIdRef = React.useRef(selectedRunnerId);
    selectedRunnerIdRef.current = selectedRunnerId;
    const [cwd, setCwd] = React.useState(initialCwd ?? "");
    const [spawning, setSpawning] = React.useState(false);
    const [spawnError, setSpawnError] = React.useState<string | null>(null);
    const [disconnectedMsg, setDisconnectedMsg] = React.useState<string | null>(null);

    // Recent folders state
    const [recentFolders, setRecentFolders] = React.useState<string[]>([]);
    const [recentFoldersLoading, setRecentFoldersLoading] = React.useState(false);
    const [recentFoldersError, setRecentFoldersError] = React.useState<string | null>(null);

    // Filtered list (derived)
    const filteredFolders = React.useMemo(
        () => filterFolders(recentFolders, cwd),
        [recentFolders, cwd],
    );

    // Virtualizer
    const listRef = React.useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: filteredFolders.length,
        getScrollElement: () => listRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: OVERSCAN,
    });

    // ── Effects ──────────────────────────────────────────────────────────

    // Reset when dialog opens/closes
    React.useEffect(() => {
        if (!open) return;
        setStep(isPreselected ? "folder" : "runner");
        setSelectedRunnerId(preselectedRunnerId ?? null);
        setCwd(initialCwd ?? "");
        setSpawnError(null);
        setDisconnectedMsg(null);
        setRecentFolders([]);
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    // Fetch recent folders when entering Step 2
    React.useEffect(() => {
        if (!open || step !== "folder" || !selectedRunnerId) return;

        let cancelled = false;
        setRecentFoldersLoading(true);
        setRecentFoldersError(null);

        fetch(`/api/runners/${encodeURIComponent(selectedRunnerId)}/recent-folders`, {
            credentials: "include",
        })
            .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then((body: any) => {
                if (cancelled) return;
                const folders = Array.isArray(body?.folders) ? (body.folders as string[]) : [];
                setRecentFolders(folders);
            })
            .catch(() => {
                if (cancelled) return;
                setRecentFoldersError("Couldn't load recent projects.");
            })
            .finally(() => {
                if (!cancelled) setRecentFoldersLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [open, step, selectedRunnerId]);

    // Watch for runner disconnect while wizard is open
    React.useEffect(() => {
        if (!open || !selectedRunnerId || step !== "folder") return;
        // Skip validation while runners list is still loading.
        // Using runnersLoading (not runners.length === 0) ensures the disconnect
        // path still fires when all runners disappear after initial load.
        if (runnersLoading) return;
        const isConnected = runners.some((r) => r.runnerId === selectedRunnerId && r.isOnline);
        if (!isConnected) {
            const remaining = runners.filter((r) => r.isOnline);
            if (remaining.length === 0) {
                onOpenChange(false);
            } else {
                setSelectedRunnerId(null);
                setStep("runner");
                setRecentFolders([]);
                setDisconnectedMsg("Runner disconnected. Please select another.");
            }
        }
    }, [runners, runnersLoading, open, selectedRunnerId, step, onOpenChange]);

    // ── Handlers ─────────────────────────────────────────────────────────

    function handleSelectRunner(runnerId: string) {
        setSelectedRunnerId(runnerId);
        setDisconnectedMsg(null);
        setStep("folder");
    }

    function handleBack() {
        setStep("runner");
        setRecentFolders([]);
        setSpawnError(null);
    }

    function handleSelectRecent(folder: string) {
        setCwd(folder);
    }

    async function handleRemoveRecent(folder: string) {
        if (!selectedRunnerId) return;
        // Capture runner id at initiation so the rollback targets the right runner.
        const initiatingRunnerId = selectedRunnerId;
        // Optimistic remove
        setRecentFolders((prev) => prev.filter((f) => f !== folder));
        try {
            const res = await fetch(
                `/api/runners/${encodeURIComponent(initiatingRunnerId)}/recent-folders`,
                {
                    method: "DELETE",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: folder }),
                },
            );
            if (!res.ok) throw new Error();
        } catch {
            // Only restore if we're still viewing the same runner
            if (selectedRunnerIdRef.current === initiatingRunnerId) {
                setRecentFolders((prev) => {
                    if (prev.includes(folder)) return prev;
                    return [...prev, folder];
                });
            }
        }
    }

    async function handleSpawn() {
        if (!selectedRunnerId || spawning) return;
        setSpawning(true);
        setSpawnError(null);
        try {
            await onSpawn(selectedRunnerId, cwd.trim() || undefined);
        } catch (err) {
            setSpawnError(err instanceof Error ? err.message : String(err));
        } finally {
            setSpawning(false);
        }
    }

    // ── Derived ───────────────────────────────────────────────────────────

    const connectedRunners = runners.filter((r) => r.isOnline);
    const selectedRunner = runners.find((r) => r.runnerId === selectedRunnerId);

    // ── Render ────────────────────────────────────────────────────────────

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!spawning) onOpenChange(o); }}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>New session</DialogTitle>
                    <DialogDescription>
                        {step === "runner"
                            ? "Select a runner to start a session on."
                            : selectedRunner
                                ? <>Starting session on <span className="font-medium text-foreground">{runnerLabel(selectedRunner)}</span>.</>
                                : "Choose a working directory."}
                    </DialogDescription>
                </DialogHeader>

                {disconnectedMsg && (
                    <p className="text-xs text-destructive -mt-1">{disconnectedMsg}</p>
                )}

                {/* ── Step 1: Runner picker ──────────────────────────────── */}
                {step === "runner" && (
                    <div className="flex flex-col gap-3">
                        {runnersLoading && (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Loading runners…
                            </div>
                        )}
                        {!runnersLoading && connectedRunners.length === 0 && (
                            <div className="text-sm text-destructive py-4">
                                No runners connected. Start one with{" "}
                                <code className="px-1 py-0.5 rounded bg-muted font-mono text-xs">pizzapi runner</code>.
                            </div>
                        )}
                        {!runnersLoading && connectedRunners.length > 0 && (
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                                {connectedRunners.map((r) => {
                                    const roots = Array.isArray(r.roots) ? r.roots.length : 0;
                                    const sessionMeta = `${r.sessionCount} session${r.sessionCount !== 1 ? "s" : ""}${roots > 0 ? ` · ${roots} root${roots !== 1 ? "s" : ""}` : ""}`;

                                    const osName = platformName(r.platform);
                                    return (
                                        <button
                                            key={r.runnerId}
                                            type="button"
                                            onClick={() => handleSelectRunner(r.runnerId)}
                                            className={cn(
                                                "flex flex-col items-start gap-2.5 rounded-xl border p-5 text-left transition-colors w-full",
                                                "hover:bg-accent hover:border-accent-foreground/20",
                                                selectedRunnerId === r.runnerId
                                                    ? "border-primary bg-primary/5"
                                                    : "border-border bg-card",
                                            )}
                                        >
                                            {/* Top row: OS label (left) + status dot (right) */}
                                            <div className="flex items-center justify-between w-full">
                                                {osName ? (
                                                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                                        <PlatformIcon platform={r.platform} />
                                                        <span>{osName}</span>
                                                    </span>
                                                ) : (
                                                    <span />
                                                )}
                                                <span className="h-2.5 w-2.5 rounded-full bg-green-500 flex-shrink-0" />
                                            </div>

                                            <span className="font-semibold text-sm leading-tight truncate w-full">
                                                {runnerLabel(r)}
                                            </span>
                                            <span className="text-xs text-muted-foreground">{sessionMeta}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                {/* ── Step 2: Folder picker ──────────────────────────────── */}
                {step === "folder" && (
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="wizard-cwd">
                                Working directory{" "}
                                <span className="text-muted-foreground font-normal">(optional)</span>
                            </Label>
                            <Input
                                id="wizard-cwd"
                                value={cwd}
                                onChange={(e) => setCwd(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") void handleSpawn(); }}
                                placeholder="/path/to/project"
                                className="font-mono text-sm"
                                disabled={spawning}
                                autoFocus
                            />
                            <p className="text-xs text-muted-foreground">
                                This is the path on the runner machine.
                            </p>
                        </div>

                        {/* Recent projects */}
                        {recentFoldersLoading && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Loading recent projects…
                            </div>
                        )}
                        {!recentFoldersLoading && recentFoldersError && (
                            <p className="text-xs text-destructive">{recentFoldersError}</p>
                        )}
                        {!recentFoldersLoading && !recentFoldersError && recentFolders.length === 0 && (
                            <p className="text-xs text-muted-foreground">No recent projects yet.</p>
                        )}
                        {!recentFoldersLoading && !recentFoldersError && recentFolders.length > 0 && (
                            <div className="flex flex-col gap-1">
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                    Recent projects
                                    {cwd.trim() && filteredFolders.length !== recentFolders.length && (
                                        <span className="normal-case tracking-normal ml-1 font-normal">
                                            ({filteredFolders.length} of {recentFolders.length})
                                        </span>
                                    )}
                                </p>
                                {/* Virtualized list */}
                                <div
                                    ref={listRef}
                                    style={{ maxHeight: LIST_MAX_HEIGHT, overflowY: "auto" }}
                                    className="rounded-md border border-border"
                                >
                                    {filteredFolders.length === 0 ? (
                                        <p className="px-3 py-2 text-xs text-muted-foreground">
                                            No matches for &ldquo;{cwd}&rdquo;.
                                        </p>
                                    ) : (
                                        <div
                                            style={{
                                                height: virtualizer.getTotalSize(),
                                                position: "relative",
                                            }}
                                        >
                                            {virtualizer.getVirtualItems().map((item) => {
                                                const folder = filteredFolders[item.index];
                                                const basename =
                                                    folder.split("/").filter(Boolean).pop() || folder;
                                                const tail = formatPathTail(folder, 2);
                                                const isSelected = cwd === folder;
                                                return (
                                                    <div
                                                        key={folder}
                                                        style={{
                                                            position: "absolute",
                                                            top: item.start,
                                                            left: 0,
                                                            right: 0,
                                                            height: ROW_HEIGHT,
                                                        }}
                                                        className={cn(
                                                            "flex items-center group px-2 gap-2",
                                                            isSelected
                                                                ? "bg-accent text-accent-foreground"
                                                                : "hover:bg-muted",
                                                        )}
                                                    >
                                                        <button
                                                            type="button"
                                                            onClick={() => handleSelectRecent(folder)}
                                                            disabled={spawning}
                                                            title={folder}
                                                            className="flex items-center gap-2 min-w-0 flex-1 text-left"
                                                        >
                                                            <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                                                            <span className="text-sm font-mono truncate">
                                                                {basename}
                                                            </span>
                                                            {tail !== basename && (
                                                                <span className="text-xs text-muted-foreground font-mono truncate">
                                                                    {tail}
                                                                </span>
                                                            )}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => void handleRemoveRecent(folder)}
                                                            disabled={spawning}
                                                            title="Remove from recent"
                                                            className="flex-shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                                                        >
                                                            <X className="h-3 w-3" />
                                                        </button>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {spawnError && (
                            <p className="text-xs text-destructive rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                                {spawnError}
                            </p>
                        )}
                    </div>
                )}

                <DialogFooter className="gap-2">
                    {step === "folder" && !isPreselected && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleBack}
                            disabled={spawning}
                            className="mr-auto"
                        >
                            <ChevronLeft className="h-4 w-4 mr-1" />
                            Back
                        </Button>
                    )}
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={spawning}
                    >
                        Cancel
                    </Button>
                    {step === "folder" && (
                        <Button
                            onClick={() => void handleSpawn()}
                            disabled={spawning || !selectedRunnerId}
                        >
                            {spawning ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Starting…
                                </>
                            ) : (
                                "Start Session"
                            )}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
