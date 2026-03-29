import { useState, type KeyboardEvent } from "react";
import { Plus, X, Save, Shield, AlertTriangle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { SectionProps } from "./RunnerSettingsPanel";

export default function SecuritySettings({ config, onSave, saving }: SectionProps) {
    const [allowProjectHooks, setAllowProjectHooks] = useState<boolean>(
        config.allowProjectHooks === true,
    );
    const [trustedPlugins, setTrustedPlugins] = useState<string[]>(
        Array.isArray(config.trustedPlugins) ? config.trustedPlugins : [],
    );
    const [pluginInput, setPluginInput] = useState("");

    const isDirty =
        allowProjectHooks !== (config.allowProjectHooks === true) ||
        JSON.stringify(trustedPlugins) !==
            JSON.stringify(Array.isArray(config.trustedPlugins) ? config.trustedPlugins : []);

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

    return (
        <div className="flex flex-col gap-6">
            {/* Section description */}
            <div className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2">
                <Shield className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                    Security settings control which external code can run in your agent sessions. Be
                    cautious when enabling these options.
                </p>
            </div>

            {/* ── Project Hooks Toggle ──────────────────────────────────── */}
            <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                    <Label htmlFor="allow-project-hooks" className="flex items-center gap-2">
                        <Lock className="h-4 w-4 text-muted-foreground" />
                        Allow Project Hooks
                    </Label>
                    <Switch
                        id="allow-project-hooks"
                        checked={allowProjectHooks}
                        onCheckedChange={setAllowProjectHooks}
                    />
                </div>

                <div
                    className={cn(
                        "flex items-start gap-2 rounded-md border px-3 py-2",
                        "border-amber-500/30 bg-amber-500/5 text-amber-400/90",
                    )}
                >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <p className="text-xs">
                        When enabled, hooks defined in project-local .pizzapi/config.json files will
                        run. This allows any project you open to execute arbitrary shell commands.
                    </p>
                </div>
            </div>

            {/* ── Trusted Plugins ───────────────────────────────────────── */}
            <div className="flex flex-col gap-3">
                <Label className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    Trusted Plugins
                </Label>

                <p className="text-xs text-muted-foreground">
                    Trusted plugins can extend the agent with custom tools and behaviors.
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

            {/* ── Save ──────────────────────────────────────────────────── */}
            <Button
                onClick={() => onSave("security", { allowProjectHooks, trustedPlugins })}
                disabled={saving || !isDirty}
                size="sm"
                className="self-end"
            >
                <Save className="mr-1.5 h-4 w-4" />
                {saving ? "Saving…" : "Save"}
            </Button>
        </div>
    );
}
