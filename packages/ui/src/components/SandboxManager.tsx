import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
    Shield,
    Loader2,
    Plus,
    X,
    ChevronDown,
    Lock,
    AlertTriangle,
    Trash2,
    Save,
    RotateCcw,
} from "lucide-react";
import { ErrorAlert } from "@/components/ui/error-alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SandboxManagerProps {
    runnerId: string;
}

interface SandboxStatus {
    mode: "none" | "basic" | "full";
    active: boolean;
    platform: string;
    violations: number;
    recentViolations: Array<{
        timestamp: string;
        operation: string;
        target: string;
        reason: string;
    }>;
    config: any;
}

interface SandboxFormState {
    mode: "none" | "basic" | "full";
    filesystem: {
        denyRead: string[];
        allowWrite: string[];
        denyWrite: string[];
    };
    network: {
        allowedDomains: string[];
        deniedDomains: string[];
        allowLocalBinding: boolean;
    };
    allowPty: boolean;
    enableWeakerNetworkIsolation: boolean;
    enableWeakerNestedSandbox: boolean;
    mandatoryDenySearchDepth: number;
}

const DEFAULT_FORM: SandboxFormState = {
    mode: "basic",
    filesystem: {
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud", "~/.docker/config.json"],
        allowWrite: [".", "/tmp"],
        denyWrite: [".env", ".env.local", "~/.ssh"],
    },
    network: {
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
    },
    allowPty: false,
    enableWeakerNetworkIsolation: false,
    enableWeakerNestedSandbox: false,
    mandatoryDenySearchDepth: 3,
};

// Default preset paths for visual distinction
const PRESET_DENY_READ = new Set(["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gcloud", "~/.docker/config.json",
    "~/Library/Application Support/Google/Chrome", "~/Library/Application Support/Firefox",
    "~/.mozilla/firefox", "~/.config/google-chrome", "~/.config/chromium"]);
const PRESET_ALLOW_WRITE = new Set([".", "/tmp"]);
const PRESET_DENY_WRITE = new Set([".env", ".env.local", "~/.ssh"]);

// ── Sub-components ────────────────────────────────────────────────────────────

function ModeBadge({ mode }: { mode: "none" | "basic" | "full" }) {
    const variants: Record<string, { bg: string; text: string; label: string }> = {
        full: { bg: "bg-emerald-500/20", text: "text-emerald-400", label: "Full" },
        basic: { bg: "bg-amber-500/20", text: "text-amber-400", label: "Basic" },
        none: { bg: "bg-zinc-500/20", text: "text-zinc-400", label: "None" },
    };
    const v = variants[mode] ?? variants.none;
    return (
        <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold", v.bg, v.text)}>
            {v.label}
        </span>
    );
}

/** Editable chip list for paths/domains */
function ChipList({ items, onRemove, onAdd, placeholder, presetItems }: {
    items: string[];
    onRemove: (index: number) => void;
    onAdd: (value: string) => void;
    placeholder: string;
    presetItems?: Set<string>;
}) {
    const [inputValue, setInputValue] = React.useState("");

    const handleAdd = () => {
        const trimmed = inputValue.trim();
        if (trimmed && !items.includes(trimmed)) {
            onAdd(trimmed);
            setInputValue("");
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            handleAdd();
        }
    };

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
                {items.map((item, i) => {
                    const isPreset = presetItems?.has(item);
                    return (
                        <span
                            key={`${item}-${i}`}
                            className={cn(
                                "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-mono",
                                isPreset
                                    ? "bg-zinc-800/60 text-zinc-500 border border-zinc-700/50"
                                    : "bg-zinc-800 text-zinc-300 border border-zinc-700"
                            )}
                        >
                            {isPreset && <Lock className="size-2.5 text-zinc-600" />}
                            {item}
                            <button
                                type="button"
                                onClick={() => onRemove(i)}
                                className="ml-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
                                title={isPreset ? "Remove default protection" : "Remove"}
                            >
                                <X className="size-3" />
                            </button>
                        </span>
                    );
                })}
            </div>
            <div className="flex items-center gap-1.5">
                <Input
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    className="flex-1 h-7 text-xs font-mono"
                />
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={handleAdd}
                    disabled={!inputValue.trim()}
                >
                    <Plus className="size-3" />
                </Button>
            </div>
        </div>
    );
}

function ViolationFeed({ violations }: {
    violations: Array<{ timestamp: string; operation: string; target: string; reason: string }>;
}) {
    if (violations.length === 0) {
        return (
            <div className="py-4 text-center text-xs text-muted-foreground">
                No violations recorded this session.
            </div>
        );
    }

    return (
        <div className="max-h-[200px] overflow-y-auto">
            <div className="flex flex-col gap-1">
                {violations.map((v, i) => {
                    const icon = v.operation === "read" ? "📖" : v.operation === "write" ? "✏️" : "⚡";
                    const ts = new Date(v.timestamp).toLocaleTimeString();
                    return (
                        <div key={i} className="flex items-start gap-2 px-1 py-1 rounded text-xs hover:bg-muted/30">
                            <span className="shrink-0">{icon}</span>
                            <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">{ts}</span>
                            <span className="font-mono text-foreground truncate">{v.target}</span>
                            <span className="text-muted-foreground truncate">— {v.reason}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ── Main component ────────────────────────────────────────────────────────────

export function SandboxManager({ runnerId }: SandboxManagerProps) {
    const [open, setOpen] = React.useState(false);
    const [loading, setLoading] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [savedBadge, setSavedBadge] = React.useState(false);

    // Live status from runner
    const [status, setStatus] = React.useState<SandboxStatus | null>(null);

    // Form state (editable)
    const [form, setForm] = React.useState<SandboxFormState>(DEFAULT_FORM);
    // Persisted state (to compare for dirty detection)
    const [persisted, setPersisted] = React.useState<SandboxFormState>(DEFAULT_FORM);

    // Section open states
    const [fsOpen, setFsOpen] = React.useState(true);
    const [netOpen, setNetOpen] = React.useState(false);
    const [advancedOpen, setAdvancedOpen] = React.useState(false);

    const isDirty = React.useMemo(() => JSON.stringify(form) !== JSON.stringify(persisted), [form, persisted]);

    const fetchStatus = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/sandbox-status`, {
                credentials: "include",
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null) as any;
                throw new Error(body?.error ?? `HTTP ${res.status}`);
            }
            const data = await res.json() as any;
            setStatus(data);

            // Populate form from raw (unresolved) config to preserve
            // relative paths like "." and "~" instead of absolute paths.
            // Falls back to resolved srtConfig for backwards compat.
            const cfg = data.rawConfig ?? data.config?.srtConfig;
            // Use the raw global config mode as the source of truth for
            // this editor — NOT the resolved `data.mode`.  The status
            // endpoint resolves mode from the merged config (global +
            // project-local), so if the daemon runs in a directory with a
            // project override, `data.mode` reflects that project mode.
            // Writing it back on save would leak project-local settings
            // into the global config.
            const mode = cfg?.mode ?? data.rawConfig?.mode ?? data.mode ?? "basic";
            const newForm: SandboxFormState = {
                mode,
                filesystem: {
                    denyRead: cfg?.filesystem?.denyRead ?? DEFAULT_FORM.filesystem.denyRead,
                    allowWrite: cfg?.filesystem?.allowWrite ?? DEFAULT_FORM.filesystem.allowWrite,
                    denyWrite: cfg?.filesystem?.denyWrite ?? DEFAULT_FORM.filesystem.denyWrite,
                },
                network: {
                    allowedDomains: cfg?.network?.allowedDomains ?? [],
                    deniedDomains: cfg?.network?.deniedDomains ?? [],
                    allowLocalBinding: cfg?.network?.allowLocalBinding ?? true,
                },
                allowPty: cfg?.allowPty ?? false,
                enableWeakerNetworkIsolation: cfg?.enableWeakerNetworkIsolation ?? false,
                enableWeakerNestedSandbox: cfg?.enableWeakerNestedSandbox ?? false,
                mandatoryDenySearchDepth: cfg?.mandatoryDenySearchDepth ?? 3,
            };
            setForm(newForm);
            setPersisted(newForm);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [runnerId]);

    React.useEffect(() => {
        if (open && !status) {
            fetchStatus();
        }
    }, [open, status, fetchStatus]);

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        setSavedBadge(false);
        try {
            const body: any = {
                mode: form.mode,
                filesystem: form.filesystem,
            };
            // Include network config for full mode, or for basic mode when
            // the user has configured network overrides (allowedDomains or
            // deniedDomains).  Dropping network on save would silently
            // remove existing basic-mode network restrictions.
            const hasNetworkOverrides =
                (form.network.allowedDomains?.length ?? 0) > 0 ||
                (form.network.deniedDomains?.length ?? 0) > 0 ||
                form.network.allowLocalBinding === false;
            if (form.mode === "full" || hasNetworkOverrides) {
                body.network = form.network;
            } else {
                // Explicitly clear stale network rules when downgrading
                // from full mode.  The backend deep-merges, so omitting
                // `network` would preserve old allowedDomains / deniedDomains
                // that could enforce deny-all behaviour in basic/none modes.
                body.network = null;
            }
            // Always include advanced options so toggling them off
            // explicitly overwrites the existing global config value.
            body.allowPty = form.allowPty ?? false;
            body.enableWeakerNetworkIsolation = form.enableWeakerNetworkIsolation ?? false;
            body.enableWeakerNestedSandbox = form.enableWeakerNestedSandbox ?? false;
            body.mandatoryDenySearchDepth = form.mandatoryDenySearchDepth ?? 3;

            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/sandbox-config`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                credentials: "include",
            });
            const data = await res.json().catch(() => null) as any;
            if (!res.ok) {
                throw new Error(data?.error ?? `HTTP ${res.status}`);
            }
            // Must have valid JSON response on HTTP 200
            if (!data || typeof data !== "object") {
                throw new Error("Invalid response from server");
            }
            // The runner may return HTTP 200 with { ok: false } on rejection
            if (data.ok === false) {
                throw new Error(data.message ?? "Runner rejected the configuration update");
            }
            setPersisted(form);
            setSavedBadge(true);
            setTimeout(() => setSavedBadge(false), 5000);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    };

    const handleDiscard = () => {
        setForm(persisted);
        setError(null);
    };

    const updateFormPath = (
        section: "denyRead" | "allowWrite" | "denyWrite",
        updater: (prev: string[]) => string[],
    ) => {
        setForm((prev) => ({
            ...prev,
            filesystem: {
                ...prev.filesystem,
                [section]: updater(prev.filesystem[section]),
            },
        }));
    };

    const updateNetworkField = (
        field: "allowedDomains" | "deniedDomains",
        updater: (prev: string[]) => string[],
    ) => {
        setForm((prev) => ({
            ...prev,
            network: {
                ...prev.network,
                [field]: updater(prev.network[field]),
            },
        }));
    };

    return (
        <Collapsible open={open} onOpenChange={setOpen}>
            <div className="flex items-center justify-between mt-3">
                <CollapsibleTrigger className="flex items-center gap-1.5 text-left group/trigger">
                    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                        Sandbox
                    </span>
                    {status && <ModeBadge mode={status.mode} />}
                    <ChevronDown
                        className={cn(
                            "h-3 w-3 text-muted-foreground/60 transition-transform duration-200",
                            open && "rotate-180"
                        )}
                    />
                </CollapsibleTrigger>
            </div>

            <CollapsibleContent>
                <div className="mt-2 flex flex-col gap-3">
                    {loading && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading sandbox status…
                        </div>
                    )}

                    {error && <ErrorAlert>{error}</ErrorAlert>}

                    {status && !loading && (
                        <>
                            {/* Status Header */}
                            <div className="flex items-center gap-2 flex-wrap px-2 py-2 rounded-lg border border-border/40 bg-muted/20">
                                <ModeBadge mode={form.mode} />
                                <span className="text-xs text-muted-foreground">
                                    {status.active ? "✅ Configured" : "❌ Not configured"}
                                </span>
                                <span className="text-xs text-muted-foreground">·</span>
                                <span className="text-xs text-muted-foreground">{status.platform}</span>
                                {status.violations > 0 && (
                                    <>
                                        <span className="text-xs text-muted-foreground">·</span>
                                        <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
                                            {status.violations} violation{status.violations !== 1 ? "s" : ""}
                                        </Badge>
                                    </>
                                )}
                            </div>

                            {/* Mode selector */}
                            <div className="flex flex-col gap-1.5">
                                <Label className="text-xs font-medium">Mode</Label>
                                <div className="flex flex-col gap-1">
                                    {(["none", "basic", "full"] as const).map((m) => {
                                        const descriptions: Record<string, string> = {
                                            none: "No sandbox restrictions",
                                            basic: "Filesystem protection, unrestricted network",
                                            full: "Filesystem + network restrictions (deny-all)",
                                        };
                                        return (
                                            <label
                                                key={m}
                                                className={cn(
                                                    "flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors",
                                                    form.mode === m ? "bg-primary/10 border border-primary/30" : "hover:bg-muted/40"
                                                )}
                                            >
                                                <input
                                                    type="radio"
                                                    name="sandbox-mode"
                                                    value={m}
                                                    checked={form.mode === m}
                                                    onChange={() => setForm((prev) => ({ ...prev, mode: m }))}
                                                    className="accent-primary"
                                                />
                                                <div>
                                                    <span className="text-xs font-semibold font-mono">{m}</span>
                                                    <p className="text-[10px] text-muted-foreground">{descriptions[m]}</p>
                                                </div>
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Filesystem section */}
                            {form.mode !== "none" && (
                                <Collapsible open={fsOpen} onOpenChange={setFsOpen}>
                                    <CollapsibleTrigger className="flex items-center gap-1.5 text-left w-full">
                                        <ChevronDown className={cn("h-3 w-3 text-muted-foreground/60 transition-transform", fsOpen && "rotate-180")} />
                                        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Filesystem</span>
                                    </CollapsibleTrigger>
                                    <CollapsibleContent className="mt-2 flex flex-col gap-3 pl-1">
                                        <div>
                                            <Label className="text-[11px] text-muted-foreground mb-1 block">Deny Read</Label>
                                            <ChipList
                                                items={form.filesystem.denyRead}
                                                onRemove={(i) => updateFormPath("denyRead", (prev) => prev.filter((_, idx) => idx !== i))}
                                                onAdd={(v) => updateFormPath("denyRead", (prev) => [...prev, v])}
                                                placeholder="Add path to deny reads…"
                                                presetItems={PRESET_DENY_READ}
                                            />
                                        </div>
                                        <div>
                                            <Label className="text-[11px] text-muted-foreground mb-1 block">Allow Write</Label>
                                            <ChipList
                                                items={form.filesystem.allowWrite}
                                                onRemove={(i) => updateFormPath("allowWrite", (prev) => prev.filter((_, idx) => idx !== i))}
                                                onAdd={(v) => updateFormPath("allowWrite", (prev) => [...prev, v])}
                                                placeholder="Add allowed write path…"
                                                presetItems={PRESET_ALLOW_WRITE}
                                            />
                                        </div>
                                        <div>
                                            <Label className="text-[11px] text-muted-foreground mb-1 block">Deny Write</Label>
                                            <ChipList
                                                items={form.filesystem.denyWrite}
                                                onRemove={(i) => updateFormPath("denyWrite", (prev) => prev.filter((_, idx) => idx !== i))}
                                                onAdd={(v) => updateFormPath("denyWrite", (prev) => [...prev, v])}
                                                placeholder="Add path to deny writes…"
                                                presetItems={PRESET_DENY_WRITE}
                                            />
                                        </div>
                                    </CollapsibleContent>
                                </Collapsible>
                            )}

                            {/* Network section (only for full mode) */}
                            {form.mode === "full" && (
                                <Collapsible open={netOpen} onOpenChange={setNetOpen}>
                                    <CollapsibleTrigger className="flex items-center gap-1.5 text-left w-full">
                                        <ChevronDown className={cn("h-3 w-3 text-muted-foreground/60 transition-transform", netOpen && "rotate-180")} />
                                        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Network</span>
                                    </CollapsibleTrigger>
                                    <CollapsibleContent className="mt-2 flex flex-col gap-3 pl-1">
                                        <div>
                                            <Label className="text-[11px] text-muted-foreground mb-1 block">Allowed Domains</Label>
                                            <ChipList
                                                items={form.network.allowedDomains}
                                                onRemove={(i) => updateNetworkField("allowedDomains", (prev) => prev.filter((_, idx) => idx !== i))}
                                                onAdd={(v) => updateNetworkField("allowedDomains", (prev) => [...prev, v])}
                                                placeholder="Add allowed domain…"
                                            />
                                        </div>
                                        <div>
                                            <Label className="text-[11px] text-muted-foreground mb-1 block">Denied Domains</Label>
                                            <ChipList
                                                items={form.network.deniedDomains}
                                                onRemove={(i) => updateNetworkField("deniedDomains", (prev) => prev.filter((_, idx) => idx !== i))}
                                                onAdd={(v) => updateNetworkField("deniedDomains", (prev) => [...prev, v])}
                                                placeholder="Add denied domain…"
                                            />
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <Label className="text-[11px] text-muted-foreground">Allow Local Binding</Label>
                                            <Switch
                                                checked={form.network.allowLocalBinding}
                                                onCheckedChange={(checked) => setForm((prev) => ({
                                                    ...prev,
                                                    network: { ...prev.network, allowLocalBinding: checked },
                                                }))}
                                            />
                                        </div>
                                    </CollapsibleContent>
                                </Collapsible>
                            )}

                            {/* Advanced section */}
                            {form.mode !== "none" && (
                                <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                                    <CollapsibleTrigger className="flex items-center gap-1.5 text-left w-full">
                                        <ChevronDown className={cn("h-3 w-3 text-muted-foreground/60 transition-transform", advancedOpen && "rotate-180")} />
                                        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Advanced</span>
                                    </CollapsibleTrigger>
                                    <CollapsibleContent className="mt-2 flex flex-col gap-2.5 pl-1">
                                        <div className="flex items-center justify-between">
                                            <Label className="text-[11px] text-muted-foreground">Allow PTY</Label>
                                            <Switch
                                                checked={form.allowPty}
                                                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, allowPty: checked }))}
                                            />
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <Label className="text-[11px] text-muted-foreground">Weaker Network Isolation</Label>
                                            <Switch
                                                checked={form.enableWeakerNetworkIsolation}
                                                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, enableWeakerNetworkIsolation: checked }))}
                                            />
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <Label className="text-[11px] text-muted-foreground">Weaker Nested Sandbox</Label>
                                            <Switch
                                                checked={form.enableWeakerNestedSandbox}
                                                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, enableWeakerNestedSandbox: checked }))}
                                            />
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <Label className="text-[11px] text-muted-foreground">Mandatory Deny Search Depth</Label>
                                            <Input
                                                type="number"
                                                min={1}
                                                max={10}
                                                value={form.mandatoryDenySearchDepth}
                                                onChange={(e) => setForm((prev) => ({
                                                    ...prev,
                                                    mandatoryDenySearchDepth: parseInt(e.target.value) || 3,
                                                }))}
                                                className="w-16 h-7 text-xs text-center"
                                            />
                                        </div>
                                    </CollapsibleContent>
                                </Collapsible>
                            )}

                            {/* Violations feed */}
                            <Collapsible>
                                <CollapsibleTrigger className="flex items-center gap-1.5 text-left w-full">
                                    <ChevronDown className="h-3 w-3 text-muted-foreground/60 transition-transform" />
                                    <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                                        Violations
                                    </span>
                                    {status.violations > 0 && (
                                        <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
                                            {status.violations}
                                        </Badge>
                                    )}
                                </CollapsibleTrigger>
                                <CollapsibleContent className="mt-2">
                                    <ViolationFeed violations={status.recentViolations} />
                                </CollapsibleContent>
                            </Collapsible>

                            {/* Footer */}
                            <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/40">
                                <div className="flex items-center gap-2">
                                    {savedBadge && (
                                        <span className="text-[11px] text-amber-400 flex items-center gap-1">
                                            <AlertTriangle className="size-3" />
                                            Changes apply on next session
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 px-2 text-xs"
                                        onClick={handleDiscard}
                                        disabled={!isDirty || saving}
                                    >
                                        <RotateCcw className="size-3 mr-1" />
                                        Discard
                                    </Button>
                                    <Button
                                        size="sm"
                                        className="h-7 px-3 text-xs"
                                        onClick={handleSave}
                                        disabled={saving || !isDirty}
                                    >
                                        {saving ? (
                                            <Loader2 className="size-3 mr-1 animate-spin" />
                                        ) : (
                                            <Save className="size-3 mr-1" />
                                        )}
                                        Save
                                    </Button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
}
