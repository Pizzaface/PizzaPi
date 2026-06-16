import { useState, useEffect } from "react";
import { Loader2, Plus, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SectionProps } from "./RunnerSettingsPanel";

interface InstalledPackage {
    source: string;
    scope: "user" | "project";
    version?: string;
    path?: string;
    type?: "npm" | "git" | "path" | "url";
}

export default function PackagesSettings({ runnerId, onSave }: SectionProps) {
    const [packages, setPackages] = useState<InstalledPackage[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [installSource, setInstallSource] = useState("");
    const [installLocal, setInstallLocal] = useState(false);

    // Fetch installed packages
    async function fetchPackages() {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/packages`);
            if (!res.ok) throw new Error(`Failed to fetch packages: ${res.statusText}`);
            const data = await res.json();
            setPackages(data.packages || []);
        } catch (err: any) {
            setError(err.message || "Failed to load packages");
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        fetchPackages();
    }, [runnerId]);

    // Install a package
    async function handleInstall() {
        if (!installSource.trim()) return;
        
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/packages/install`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ source: installSource.trim(), local: installLocal }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `Install failed: ${res.statusText}`);
            }
            setInstallSource("");
            setInstallLocal(false);
            fetchPackages();
        } catch (err: any) {
            setError(err.message || "Failed to install package");
        }
    }

    // Remove a package
    async function handleRemove(source: string, scope: "user" | "project") {
        if (!confirm(`Remove package "${source}" from ${scope} scope?`)) return;
        
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/packages/remove`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ source, local: scope === "project" }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `Remove failed: ${res.statusText}`);
            }
            fetchPackages();
        } catch (err: any) {
            setError(err.message || "Failed to remove package");
        }
    }

    // Update all packages (extensions only, no self-update)
    async function handleUpdateAll() {
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/packages/update`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `Update failed: ${res.statusText}`);
            }
            fetchPackages();
        } catch (err: any) {
            setError(err.message || "Failed to update packages");
        }
    }

    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <h3 className="text-sm font-semibold">Installed Packages</h3>
                <p className="text-xs text-muted-foreground">
                    Manage pi packages (extensions, skills, prompts, themes). Packages are stored in settings.json.
                </p>
            </div>

            {error && (
                <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 p-2 rounded">
                    {error}
                </div>
            )}

            {/* Install form */}
            <div className="border rounded-lg p-3 space-y-3">
                <h4 className="text-xs font-medium text-muted-foreground">Install Package</h4>
                <div className="flex gap-2">
                    <input
                        type="text"
                        placeholder="npm:@scope/pkg or git:github.com/user/repo"
                        value={installSource}
                        onChange={(e) => setInstallSource(e.target.value)}
                        className="flex-1 text-sm px-3 py-1.5 rounded border bg-background"
                        onKeyDown={(e) => e.key === "Enter" && handleInstall()}
                    />
                    <label className="flex items-center gap-1 text-xs">
                        <input
                            type="checkbox"
                            checked={installLocal}
                            onChange={(e) => setInstallLocal(e.target.checked)}
                        />
                        Local
                    </label>
                    <Button
                        size="sm"
                        onClick={handleInstall}
                        disabled={!installSource.trim() || loading}
                    >
                        <Plus className="h-3 w-3 mr-1" />
                        Install
                    </Button>
                </div>
            </div>

            {/* Update button */}
            <div className="flex justify-end">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleUpdateAll}
                    disabled={loading || packages.length === 0}
                >
                    <RefreshCw className={cn("h-3 w-3 mr-1", loading && "animate-spin")} />
                    Update All
                </Button>
            </div>

            {/* Package list */}
            {loading && packages.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
            ) : packages.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">
                    No packages installed
                </div>
            ) : (
                <div className="space-y-2">
                    {packages.map((pkg, idx) => (
                        <div
                            key={idx}
                            className="flex items-start justify-between gap-2 p-3 border rounded-lg"
                        >
                            <div className="flex-1 min-w-0">
                                <div className="font-medium text-sm truncate">{pkg.source}</div>
                                <div className="text-xs text-muted-foreground mt-0.5">
                                    <span className="inline-block px-1.5 py-0.5 rounded bg-muted font-mono">
                                        {pkg.scope}
                                    </span>
                                    {pkg.version && <span className="ml-2">v{pkg.version}</span>}
                                    {pkg.type && <span className="ml-2 text-muted-foreground/70">{pkg.type}</span>}
                                </div>
                                {pkg.path && (
                                    <div className="text-xs text-muted-foreground mt-1 font-mono truncate">
                                        {pkg.path}
                                    </div>
                                )}
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleRemove(pkg.source, pkg.scope)}
                                className="text-red-500 hover:text-red-700"
                                title="Remove package"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
