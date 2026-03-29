/**
 * HooksManager — standalone hook editor for the top-level Hooks tab.
 *
 * Fetches global config from the runner settings API, renders the hook editor
 * (same as HooksSettings) plus the "Allow Project Hooks" toggle, and saves
 * back via the same API.
 */
import * as React from "react";
import { useState, useEffect, useCallback } from "react";
import {
    Plus,
    Save,
    Webhook,
    ChevronDown,
    Trash2,
    Info,
    Loader2,
    RotateCcw,
    Lock,
    AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ErrorAlert } from "@/components/ui/error-alert";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HooksManagerProps {
    runnerId: string;
    /** When true, render without outer padding (for tab/panel use) */
    bare?: boolean;
}

interface HookEntry {
    command: string;
    timeout?: number;
}

interface MatcherHookGroup {
    matcher: string;
    hooks: HookEntry[];
}

type MatcherHookType = "PreToolUse" | "PostToolUse";
type SimpleHookType =
    | "Input"
    | "BeforeAgentStart"
    | "UserBash"
    | "SessionBeforeSwitch"
    | "SessionBeforeFork"
    | "SessionShutdown"
    | "SessionBeforeCompact"
    | "SessionBeforeTree"
    | "ModelSelect";

type HookType = MatcherHookType | SimpleHookType;

const MATCHER_HOOK_TYPES: MatcherHookType[] = ["PreToolUse", "PostToolUse"];
const SIMPLE_HOOK_TYPES: SimpleHookType[] = [
    "Input",
    "BeforeAgentStart",
    "UserBash",
    "SessionBeforeSwitch",
    "SessionBeforeFork",
    "SessionShutdown",
    "SessionBeforeCompact",
    "SessionBeforeTree",
    "ModelSelect",
];
const ALL_HOOK_TYPES: HookType[] = [...MATCHER_HOOK_TYPES, ...SIMPLE_HOOK_TYPES];

function isMatcherType(type: HookType): type is MatcherHookType {
    return MATCHER_HOOK_TYPES.includes(type as MatcherHookType);
}

function cloneHooks(hooks: Record<string, any>): Record<string, any> {
    return JSON.parse(JSON.stringify(hooks ?? {}));
}

// ── Component ─────────────────────────────────────────────────────────────────

export function HooksManager({ runnerId, bare }: HooksManagerProps) {
    // Data from the runner
    const [config, setConfig] = useState<Record<string, any> | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // Hook editor state
    const [hooks, setHooks] = useState<Record<string, any>>({});
    const [openSections, setOpenSections] = useState<Set<HookType>>(new Set());

    // allowProjectHooks state
    const [allowProjectHooks, setAllowProjectHooks] = useState(false);

    // ── Fetch ─────────────────────────────────────────────────────────────────

    const fetchSettings = useCallback(async () => {
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
            setConfig(cfg);
            setHooks(cloneHooks(cfg.hooks));
            setAllowProjectHooks(cfg.allowProjectHooks === true);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [runnerId]);

    useEffect(() => {
        fetchSettings();
    }, [fetchSettings]);

    // ── Save ──────────────────────────────────────────────────────────────────

    const handleSave = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
            // Strip empty entries before saving
            const cleaned = cloneHooks(hooks);
            for (const type of ALL_HOOK_TYPES) {
                if (!(type in cleaned)) continue;
                if (isMatcherType(type)) {
                    const groups = cleaned[type] as MatcherHookGroup[];
                    const filtered = groups
                        .map((g) => ({
                            ...g,
                            hooks: g.hooks.filter((h: HookEntry) => h.command.trim() !== ""),
                        }))
                        .filter((g) => g.hooks.length > 0 && g.matcher.trim() !== "");
                    if (filtered.length === 0) delete cleaned[type];
                    else cleaned[type] = filtered;
                } else {
                    const entries = (cleaned[type] as HookEntry[]).filter(
                        (h) => h.command.trim() !== "",
                    );
                    if (entries.length === 0) delete cleaned[type];
                    else cleaned[type] = entries;
                }
            }

            // Save hooks
            const hooksRes = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/settings`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ section: "hooks", value: cleaned }),
            });
            if (!hooksRes.ok) {
                const body = await hooksRes.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${hooksRes.status}`);
            }

            // Save allowProjectHooks (security section)
            const secRes = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/settings`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ section: "security", value: { allowProjectHooks, trustedPlugins: config?.trustedPlugins } }),
            });
            if (!secRes.ok) {
                const body = await secRes.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${secRes.status}`);
            }

            // Refresh
            await fetchSettings();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }, [runnerId, hooks, allowProjectHooks, config, fetchSettings]);

    // ── Dirty check ───────────────────────────────────────────────────────────

    const isDirty =
        config !== null &&
        (JSON.stringify(hooks) !== JSON.stringify(config.hooks ?? {}) ||
            allowProjectHooks !== (config.allowProjectHooks === true));

    // ── Hook editing helpers ──────────────────────────────────────────────────

    const toggleSection = useCallback((type: HookType) => {
        setOpenSections((prev) => {
            const next = new Set(prev);
            if (next.has(type)) next.delete(type);
            else next.add(type);
            return next;
        });
    }, []);

    // Matcher hook types (PreToolUse / PostToolUse)
    const addMatcherGroup = (type: MatcherHookType) => {
        setHooks((prev) => {
            const next = cloneHooks(prev);
            const groups: MatcherHookGroup[] = next[type] ?? [];
            groups.push({ matcher: "*", hooks: [{ command: "" }] });
            next[type] = groups;
            return next;
        });
        setOpenSections((prev) => new Set(prev).add(type));
    };

    const removeMatcherGroup = (type: MatcherHookType, groupIdx: number) => {
        setHooks((prev) => {
            const next = cloneHooks(prev);
            const groups: MatcherHookGroup[] = next[type] ?? [];
            groups.splice(groupIdx, 1);
            if (groups.length === 0) delete next[type];
            else next[type] = groups;
            return next;
        });
    };

    const updateMatcherGroupField = (
        type: MatcherHookType,
        groupIdx: number,
        field: "matcher",
        value: string,
    ) => {
        setHooks((prev) => {
            const next = cloneHooks(prev);
            next[type][groupIdx][field] = value;
            return next;
        });
    };

    const addMatcherHookEntry = (type: MatcherHookType, groupIdx: number) => {
        setHooks((prev) => {
            const next = cloneHooks(prev);
            next[type][groupIdx].hooks.push({ command: "" });
            return next;
        });
    };

    const removeMatcherHookEntry = (type: MatcherHookType, groupIdx: number, hookIdx: number) => {
        setHooks((prev) => {
            const next = cloneHooks(prev);
            const entries: HookEntry[] = next[type][groupIdx].hooks;
            entries.splice(hookIdx, 1);
            if (entries.length === 0) {
                next[type].splice(groupIdx, 1);
                if (next[type].length === 0) delete next[type];
            }
            return next;
        });
    };

    const updateMatcherHookEntry = (
        type: MatcherHookType,
        groupIdx: number,
        hookIdx: number,
        field: "command" | "timeout",
        value: string | number | undefined,
    ) => {
        setHooks((prev) => {
            const next = cloneHooks(prev);
            const entry: HookEntry = next[type][groupIdx].hooks[hookIdx];
            if (field === "timeout") {
                if (value === undefined || value === "") delete entry.timeout;
                else entry.timeout = Number(value);
            } else {
                entry.command = value as string;
            }
            return next;
        });
    };

    // Simple hook types
    const addSimpleHook = (type: SimpleHookType) => {
        setHooks((prev) => {
            const next = cloneHooks(prev);
            const entries: HookEntry[] = next[type] ?? [];
            entries.push({ command: "" });
            next[type] = entries;
            return next;
        });
        setOpenSections((prev) => new Set(prev).add(type));
    };

    const removeSimpleHook = (type: SimpleHookType, idx: number) => {
        setHooks((prev) => {
            const next = cloneHooks(prev);
            const entries: HookEntry[] = next[type] ?? [];
            entries.splice(idx, 1);
            if (entries.length === 0) delete next[type];
            else next[type] = entries;
            return next;
        });
    };

    const updateSimpleHook = (
        type: SimpleHookType,
        idx: number,
        field: "command" | "timeout",
        value: string | number | undefined,
    ) => {
        setHooks((prev) => {
            const next = cloneHooks(prev);
            const entry: HookEntry = next[type][idx];
            if (field === "timeout") {
                if (value === undefined || value === "") delete entry.timeout;
                else entry.timeout = Number(value);
            } else {
                entry.command = value as string;
            }
            return next;
        });
    };

    // Counts
    const countForType = (type: HookType): number => {
        const data = hooks[type];
        if (!data) return 0;
        if (isMatcherType(type)) {
            return (data as MatcherHookGroup[]).reduce(
                (acc: number, g: MatcherHookGroup) => acc + g.hooks.length,
                0,
            );
        }
        return (data as HookEntry[]).length;
    };

    // ── Loading / error states ────────────────────────────────────────────────

    if (loading && !config) {
        return (
            <div className="flex items-center justify-center p-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Loading hooks…</span>
            </div>
        );
    }

    if (error && !config) {
        return (
            <div className="p-4">
                <ErrorAlert>{error}</ErrorAlert>
                <Button variant="outline" size="sm" className="mt-3" onClick={fetchSettings}>
                    <RotateCcw className="h-3.5 w-3.5 mr-1" />
                    Retry
                </Button>
            </div>
        );
    }

    if (!config) return null;

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className={cn("flex flex-col gap-4", !bare && "p-4")}>
            {/* Error banner */}
            {error && (
                <div className="flex items-center justify-between">
                    <ErrorAlert className="flex-1">{error}</ErrorAlert>
                    <button
                        type="button"
                        onClick={() => setError(null)}
                        className="ml-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                        ✕
                    </button>
                </div>
            )}

            {/* ── Allow Project Hooks toggle ──────────────────────────── */}
            <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
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

            {/* ── Hook types ──────────────────────────────────────────── */}
            {ALL_HOOK_TYPES.map((type) => {
                const isOpen = openSections.has(type);
                const count = countForType(type);
                const isMatcher = isMatcherType(type);

                return (
                    <Collapsible key={type} open={isOpen} onOpenChange={() => toggleSection(type)}>
                        <div className="rounded-lg border border-border bg-card">
                            <CollapsibleTrigger asChild>
                                <button
                                    type="button"
                                    className={cn(
                                        "flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium",
                                        "hover:bg-muted/50 transition-colors",
                                        isOpen && "border-b border-border",
                                    )}
                                >
                                    <Webhook className="size-4 shrink-0 text-muted-foreground" />
                                    <span className="flex-1">{type}</span>
                                    {count > 0 && (
                                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                                            {count}
                                        </span>
                                    )}
                                    <ChevronDown
                                        className={cn(
                                            "size-4 text-muted-foreground transition-transform",
                                            isOpen && "rotate-180",
                                        )}
                                    />
                                </button>
                            </CollapsibleTrigger>

                            <CollapsibleContent>
                                <div className="flex flex-col gap-3 p-4">
                                    {isMatcher
                                        ? renderMatcherSection(type as MatcherHookType)
                                        : renderSimpleSection(type as SimpleHookType)}
                                </div>
                            </CollapsibleContent>
                        </div>
                    </Collapsible>
                );
            })}

            {/* Info note */}
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" />
                <span>Changes apply on next session start. These are global hooks only.</span>
            </div>

            {/* Save */}
            <div>
                <Button onClick={handleSave} disabled={saving || !isDirty} className="gap-2">
                    {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                    Save
                </Button>
            </div>
        </div>
    );

    // ── Matcher section renderer ──────────────────────────────────────────────

    function renderMatcherSection(type: MatcherHookType) {
        const groups: MatcherHookGroup[] = hooks[type] ?? [];

        return (
            <>
                {groups.length === 0 && (
                    <p className="text-sm text-muted-foreground">No hooks configured.</p>
                )}

                {groups.map((group, groupIdx) => (
                    <div
                        key={groupIdx}
                        className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3"
                    >
                        <div className="flex items-end gap-2">
                            <div className="flex flex-1 flex-col gap-1.5">
                                <Label className="text-xs text-muted-foreground">Matcher pattern</Label>
                                <Input
                                    value={group.matcher}
                                    onChange={(e) =>
                                        updateMatcherGroupField(type, groupIdx, "matcher", e.target.value)
                                    }
                                    placeholder="e.g. Bash, *, Read"
                                    className="font-mono text-sm"
                                />
                            </div>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="shrink-0 text-destructive hover:text-destructive"
                                onClick={() => removeMatcherGroup(type, groupIdx)}
                                title="Remove matcher group"
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </div>

                        {group.hooks.map((hook: HookEntry, hookIdx: number) => (
                            <div key={hookIdx} className="flex items-end gap-2 pl-4">
                                <div className="flex flex-1 flex-col gap-1.5">
                                    <Label className="text-xs text-muted-foreground">Command</Label>
                                    <Input
                                        value={hook.command}
                                        onChange={(e) =>
                                            updateMatcherHookEntry(type, groupIdx, hookIdx, "command", e.target.value)
                                        }
                                        placeholder="/path/to/hook.sh"
                                        className="font-mono text-sm"
                                    />
                                </div>
                                <div className="flex w-28 flex-col gap-1.5">
                                    <Label className="text-xs text-muted-foreground">Timeout (ms)</Label>
                                    <Input
                                        type="number"
                                        value={hook.timeout ?? ""}
                                        onChange={(e) =>
                                            updateMatcherHookEntry(
                                                type,
                                                groupIdx,
                                                hookIdx,
                                                "timeout",
                                                e.target.value === "" ? undefined : e.target.value,
                                            )
                                        }
                                        placeholder="—"
                                        className="text-sm"
                                    />
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="shrink-0 text-muted-foreground hover:text-destructive"
                                    onClick={() => removeMatcherHookEntry(type, groupIdx, hookIdx)}
                                    title="Remove hook"
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            </div>
                        ))}

                        <Button
                            variant="ghost"
                            size="sm"
                            className="ml-4 w-fit gap-1.5 text-xs text-muted-foreground"
                            onClick={() => addMatcherHookEntry(type, groupIdx)}
                        >
                            <Plus className="size-3" />
                            Add hook to this matcher
                        </Button>
                    </div>
                ))}

                <Button
                    variant="outline"
                    size="sm"
                    className="w-fit gap-1.5"
                    onClick={() => addMatcherGroup(type)}
                >
                    <Plus className="size-4" />
                    Add matcher group
                </Button>
            </>
        );
    }

    // ── Simple section renderer ───────────────────────────────────────────────

    function renderSimpleSection(type: SimpleHookType) {
        const entries: HookEntry[] = hooks[type] ?? [];

        return (
            <>
                {entries.length === 0 && (
                    <p className="text-sm text-muted-foreground">No hooks configured.</p>
                )}

                {entries.map((hook, idx) => (
                    <div key={idx} className="flex items-end gap-2">
                        <div className="flex flex-1 flex-col gap-1.5">
                            <Label className="text-xs text-muted-foreground">Command</Label>
                            <Input
                                value={hook.command}
                                onChange={(e) => updateSimpleHook(type, idx, "command", e.target.value)}
                                placeholder="/path/to/hook.sh"
                                className="font-mono text-sm"
                            />
                        </div>
                        <div className="flex w-28 flex-col gap-1.5">
                            <Label className="text-xs text-muted-foreground">Timeout (ms)</Label>
                            <Input
                                type="number"
                                value={hook.timeout ?? ""}
                                onChange={(e) =>
                                    updateSimpleHook(
                                        type,
                                        idx,
                                        "timeout",
                                        e.target.value === "" ? undefined : e.target.value,
                                    )
                                }
                                placeholder="—"
                                className="text-sm"
                            />
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="shrink-0 text-muted-foreground hover:text-destructive"
                            onClick={() => removeSimpleHook(type, idx)}
                            title="Remove hook"
                        >
                            <Trash2 className="size-4" />
                        </Button>
                    </div>
                ))}

                <Button
                    variant="outline"
                    size="sm"
                    className="w-fit gap-1.5"
                    onClick={() => addSimpleHook(type)}
                >
                    <Plus className="size-4" />
                    Add hook
                </Button>
            </>
        );
    }
}
