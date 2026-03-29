/**
 * TrustedPluginsEditor — standalone editor for the trustedPlugins config.
 *
 * Self-contained: fetches config from the runner settings API and saves back.
 * Used in the top-level Plugins tab.
 */
import { useState, useEffect, useCallback, type KeyboardEvent } from "react";
import { Plus, X, Save, Shield, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorAlert } from "@/components/ui/error-alert";
import { cn } from "@/lib/utils";

export interface TrustedPluginsEditorProps {
    runnerId: string;
}

export function TrustedPluginsEditor({ runnerId }: TrustedPluginsEditorProps) {
    const [trustedPlugins, setTrustedPlugins] = useState<string[]>([]);
    const [savedPlugins, setSavedPlugins] = useState<string[]>([]);
    const [pluginInput, setPluginInput] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // We need allowProjectHooks to preserve it when saving the security section
    const [allowProjectHooks, setAllowProjectHooks] = useState(false);

    const fetchConfig = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/settings`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            const result = await res.json();
            const cfg = result.config ?? {};
            const plugins = Array.isArray(cfg.trustedPlugins) ? cfg.trustedPlugins : [];
            setTrustedPlugins(plugins);
            setSavedPlugins(plugins);
            setAllowProjectHooks(cfg.allowProjectHooks === true);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [runnerId]);

    useEffect(() => {
        fetchConfig();
    }, [fetchConfig]);

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/settings`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    section: "security",
                    value: { allowProjectHooks, trustedPlugins },
                }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            setSavedPlugins([...trustedPlugins]);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    };

    const isDirty = JSON.stringify(trustedPlugins) !== JSON.stringify(savedPlugins);

    function addPlugin() {
        const trimmed = pluginInput.trim();
        if (!trimmed || trustedPlugins.includes(trimmed)) return;
        setTrustedPlugins([...trustedPlugins, trimmed]);
        setPluginInput("");
    }

    function removePlugin(index: number) {
        setTrustedPlugins(trustedPlugins.filter((_, i) => i !== index));
    }

    function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter") {
            e.preventDefault();
            addPlugin();
        }
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center p-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Loading…</span>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {error && <ErrorAlert>{error}</ErrorAlert>}

            <div className="flex flex-col gap-3">
                <Label className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    Trusted Plugins
                </Label>
                <p className="text-xs text-muted-foreground">
                    Trusted plugin directories can extend the agent with custom tools and behaviors.
                    Changes apply on next session start.
                </p>

                {/* Plugin list */}
                {trustedPlugins.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {trustedPlugins.map((path, i) => (
                            <span
                                key={i}
                                className={cn(
                                    "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5",
                                    "bg-muted/60 text-xs font-mono text-foreground/80",
                                    "border border-border/50",
                                )}
                            >
                                {path}
                                <button
                                    type="button"
                                    onClick={() => removePlugin(i)}
                                    className="ml-0.5 rounded-full p-0.5 hover:bg-destructive/20 hover:text-destructive transition-colors"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </span>
                        ))}
                    </div>
                )}

                {trustedPlugins.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">No trusted plugins configured.</p>
                )}

                {/* Add input */}
                <div className="flex gap-2">
                    <Input
                        value={pluginInput}
                        onChange={(e) => setPluginInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="/path/to/plugin"
                        className="flex-1 font-mono text-xs"
                    />
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addPlugin}
                        disabled={!pluginInput.trim()}
                    >
                        <Plus className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* Save */}
            <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
                    <Save className="mr-1.5 h-4 w-4" />
                    {saving ? "Saving…" : "Save"}
                </Button>
            </div>
        </div>
    );
}
