import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, X, Save, Terminal, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SectionProps } from "./RunnerSettingsPanel";

/** Common PIZZAPI_ env vars shown in the add-row dropdown. */
const COMMON_VARS: { name: string; hint: string }[] = [
    { name: "PIZZAPI_NO_HOOKS", hint: '"1" to disable hooks' },
    { name: "PIZZAPI_NO_MCP", hint: '"1" to disable MCP servers' },
    { name: "PIZZAPI_NO_PLUGINS", hint: '"1" to disable plugins' },
    { name: "PIZZAPI_NO_RELAY", hint: '"1" to disable relay' },
    { name: "PIZZAPI_RUNNER_ROOTS", hint: "comma-separated paths" },
    { name: "PIZZAPI_WORKSPACE_ROOTS", hint: "comma-separated paths" },
    { name: "PIZZAPI_HIDDEN_MODELS", hint: "comma-separated model IDs" },
    { name: "PIZZAPI_SANDBOX_MODE", hint: '"none", "basic", or "full"' },
    { name: "PIZZAPI_WEB_SEARCH", hint: '"1" to enable' },
];

interface EnvEntry {
    id: number;
    key: string;
    value: string;
}

let nextId = 1;

function toEntries(obj: Record<string, string> | undefined): EnvEntry[] {
    if (!obj || typeof obj !== "object") return [];
    return Object.entries(obj).map(([key, value]) => ({
        id: nextId++,
        key,
        value: String(value),
    }));
}

function toRecord(entries: EnvEntry[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const e of entries) {
        const k = e.key.trim();
        if (k) result[k] = e.value;
    }
    return result;
}

export default function EnvVarsSettings({ config, onSave, saving }: SectionProps) {
    const [entries, setEntries] = useState<EnvEntry[]>(() => toEntries(config.envOverrides));
    const [showDropdown, setShowDropdown] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Re-sync when config changes externally
    useEffect(() => {
        setEntries(toEntries(config.envOverrides));
    }, [config]);

    // Close dropdown on outside click
    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setShowDropdown(false);
            }
        }
        if (showDropdown) {
            document.addEventListener("mousedown", handleClick);
            return () => document.removeEventListener("mousedown", handleClick);
        }
    }, [showDropdown]);

    const updateEntry = useCallback((id: number, field: "key" | "value", val: string) => {
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: val } : e)));
    }, []);

    const removeEntry = useCallback((id: number) => {
        setEntries((prev) => prev.filter((e) => e.id !== id));
    }, []);

    const addEntry = useCallback((key = "", value = "") => {
        setEntries((prev) => [...prev, { id: nextId++, key, value }]);
        setShowDropdown(false);
    }, []);

    const handleSave = () => {
        onSave("envVars", toRecord(entries));
    };

    // Dirty detection
    const currentRecord = toRecord(entries);
    const savedRecord = (config.envOverrides as Record<string, string>) ?? {};
    const isDirty =
        JSON.stringify(currentRecord, Object.keys(currentRecord).sort()) !==
        JSON.stringify(savedRecord, Object.keys(savedRecord).sort());

    // Warnings
    const nonPrefixedKeys = entries.filter((e) => {
        const k = e.key.trim();
        return k.length > 0 && !k.startsWith("PIZZAPI_");
    });

    // Which common vars are already used
    const usedKeys = new Set(entries.map((e) => e.key.trim()));
    const availableVars = COMMON_VARS.filter((v) => !usedKeys.has(v.name));

    return (
        <div className="flex flex-col gap-6">
            {/* Header description */}
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                <Terminal className="mt-0.5 size-4 shrink-0" />
                <span>
                    Environment variable overrides are applied when the runner starts. Restart the runner for
                    changes to take effect.
                </span>
            </div>

            {/* Key-value table */}
            {entries.length > 0 && (
                <div className="flex flex-col gap-1">
                    {/* Column headers */}
                    <div className="grid grid-cols-[1fr_1fr_40px] gap-2 px-1">
                        <Label className="text-xs text-muted-foreground">Variable</Label>
                        <Label className="text-xs text-muted-foreground">Value</Label>
                        <span />
                    </div>

                    {entries.map((entry) => {
                        const trimmedKey = entry.key.trim();
                        const hasWarning = trimmedKey.length > 0 && !trimmedKey.startsWith("PIZZAPI_");
                        return (
                            <div
                                key={entry.id}
                                className="grid grid-cols-[1fr_1fr_40px] items-center gap-2"
                            >
                                <div className="relative">
                                    <Input
                                        value={entry.key}
                                        onChange={(e) => updateEntry(entry.id, "key", e.target.value)}
                                        placeholder="PIZZAPI_..."
                                        className={cn(
                                            "font-mono text-sm",
                                            hasWarning && "border-yellow-500/60 focus-visible:ring-yellow-500/40",
                                        )}
                                        spellCheck={false}
                                    />
                                </div>
                                <Input
                                    value={entry.value}
                                    onChange={(e) => updateEntry(entry.id, "value", e.target.value)}
                                    placeholder="value"
                                    className="text-sm"
                                    spellCheck={false}
                                />
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="size-8 text-muted-foreground hover:text-destructive"
                                    onClick={() => removeEntry(entry.id)}
                                >
                                    <X className="size-4" />
                                </Button>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Empty state */}
            {entries.length === 0 && (
                <p className="text-sm text-muted-foreground">No environment variable overrides configured.</p>
            )}

            {/* Warning for non-PIZZAPI_ keys */}
            {nonPrefixedKeys.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-400">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>
                        {nonPrefixedKeys.length === 1 ? (
                            <>
                                <Badge variant="outline" className="font-mono text-xs mr-1">
                                    {nonPrefixedKeys[0].key.trim()}
                                </Badge>
                                doesn&apos;t start with <code className="font-mono">PIZZAPI_</code>. Only{" "}
                                <code className="font-mono">PIZZAPI_</code>-prefixed variables are supported.
                            </>
                        ) : (
                            <>
                                {nonPrefixedKeys.length} variables don&apos;t start with{" "}
                                <code className="font-mono">PIZZAPI_</code>. Only{" "}
                                <code className="font-mono">PIZZAPI_</code>-prefixed variables are supported.
                            </>
                        )}
                    </span>
                </div>
            )}

            {/* Add row button with dropdown */}
            <div className="relative" ref={dropdownRef}>
                <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => {
                        if (availableVars.length > 0) {
                            setShowDropdown((v) => !v);
                        } else {
                            addEntry();
                        }
                    }}
                >
                    <Plus className="size-4" />
                    Add Variable
                </Button>

                {showDropdown && availableVars.length > 0 && (
                    <div className="absolute left-0 top-full z-50 mt-1 w-96 rounded-md border border-border bg-popover shadow-lg">
                        <div className="max-h-64 overflow-y-auto py-1">
                            {/* Custom entry option */}
                            <button
                                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
                                onClick={() => addEntry()}
                            >
                                <Plus className="size-3.5 text-muted-foreground" />
                                <span className="text-muted-foreground">Custom variable…</span>
                            </button>

                            <div className="my-1 border-t border-border" />

                            {availableVars.map((v) => (
                                <button
                                    key={v.name}
                                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
                                    onClick={() => addEntry(v.name)}
                                >
                                    <code className="font-mono text-xs">{v.name}</code>
                                    <span className="text-xs text-muted-foreground">{v.hint}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* Save button */}
            <div>
                <Button onClick={handleSave} disabled={saving || !isDirty} className="gap-2">
                    {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                    Save
                </Button>
            </div>
        </div>
    );
}
