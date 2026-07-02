import { useState, useEffect, useMemo } from "react";
import { Plus, Save, Trash2, Layers, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { SectionProps } from "./RunnerSettingsPanel";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Tri-state for boolean overrides: inherit the global value, or force on/off. */
type TriState = "inherit" | "on" | "off";

interface OverrideDraft {
    builtinSystemPrompt: TriState;
    sendAgentsMd: TriState;
    /** Whether appendSystemPrompt is overridden (empty string is a valid override). */
    appendOverride: boolean;
    appendSystemPrompt: string;
    /** Comma-separated MCP server names. */
    disabledMcpServers: string;
}

const EMPTY_DRAFT: OverrideDraft = {
    builtinSystemPrompt: "inherit",
    sendAgentsMd: "inherit",
    appendOverride: false,
    appendSystemPrompt: "",
    disabledMcpServers: "",
};

// ── Serialization ─────────────────────────────────────────────────────────────

function toDraft(raw: Record<string, unknown>): OverrideDraft {
    const tri = (v: unknown): TriState => (v === true ? "on" : v === false ? "off" : "inherit");
    return {
        builtinSystemPrompt: tri(raw.builtinSystemPrompt),
        sendAgentsMd: tri(raw.sendAgentsMd),
        appendOverride: typeof raw.appendSystemPrompt === "string",
        appendSystemPrompt: typeof raw.appendSystemPrompt === "string" ? raw.appendSystemPrompt : "",
        disabledMcpServers: Array.isArray(raw.disabledMcpServers)
            ? (raw.disabledMcpServers as string[]).join(", ")
            : "",
    };
}

function fromDraft(draft: OverrideDraft): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (draft.builtinSystemPrompt !== "inherit") out.builtinSystemPrompt = draft.builtinSystemPrompt === "on";
    if (draft.sendAgentsMd !== "inherit") out.sendAgentsMd = draft.sendAgentsMd === "on";
    if (draft.appendOverride) out.appendSystemPrompt = draft.appendSystemPrompt;
    const servers = draft.disabledMcpServers
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (servers.length > 0) out.disabledMcpServers = servers;
    return out;
}

function initialDrafts(config: Record<string, any>): Record<string, OverrideDraft> {
    const drafts: Record<string, OverrideDraft> = {};
    const ps = config.providerSettings;
    if (ps && typeof ps === "object") {
        for (const [provider, entry] of Object.entries(ps as Record<string, any>)) {
            if (entry && typeof entry === "object" && entry.overrides && typeof entry.overrides === "object") {
                drafts[provider] = toDraft(entry.overrides);
            }
        }
    }
    return drafts;
}

// ── Tri-state select ──────────────────────────────────────────────────────────

function TriStateSelect({
    id,
    value,
    onChange,
}: {
    id: string;
    value: TriState;
    onChange: (v: TriState) => void;
}) {
    return (
        <Select value={value} onValueChange={(v) => onChange(v as TriState)}>
            <SelectTrigger id={id} className="w-32 h-8 text-xs">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="inherit">Inherit</SelectItem>
                <SelectItem value="on">On</SelectItem>
                <SelectItem value="off">Off</SelectItem>
            </SelectContent>
        </Select>
    );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProviderOverridesSettings({ runnerId, config, onSave, saving }: SectionProps) {
    const [drafts, setDrafts] = useState<Record<string, OverrideDraft>>(() => initialDrafts(config));
    const [newProvider, setNewProvider] = useState("");
    const [knownProviders, setKnownProviders] = useState<string[]>([]);

    // Fetch configured providers for the datalist suggestions (best-effort).
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/models`);
                if (!res.ok) return;
                const data = await res.json();
                if (cancelled) return;
                const providers = [...new Set((data.models ?? []).map((m: any) => m.provider))] as string[];
                setKnownProviders(providers.sort());
            } catch {
                // Suggestions only — free-text entry still works.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [runnerId]);

    const suggestions = useMemo(
        () => knownProviders.filter((p) => !(p in drafts)),
        [knownProviders, drafts],
    );

    const updateDraft = (provider: string, patch: Partial<OverrideDraft>) => {
        setDrafts((prev) => ({ ...prev, [provider]: { ...prev[provider], ...patch } }));
    };

    const addProvider = () => {
        const name = newProvider.trim();
        if (!name || name in drafts) return;
        setDrafts((prev) => ({ ...prev, [name]: { ...EMPTY_DRAFT } }));
        setNewProvider("");
    };

    const removeProvider = (provider: string) => {
        setDrafts((prev) => {
            const next = { ...prev };
            delete next[provider];
            return next;
        });
    };

    const handleSave = () => {
        const payload: Record<string, unknown> = {};
        for (const [provider, draft] of Object.entries(drafts)) {
            const overrides = fromDraft(draft);
            if (Object.keys(overrides).length > 0) payload[provider] = overrides;
        }
        void onSave("providerOverrides", payload);
    };

    const providerNames = Object.keys(drafts).sort();

    return (
        <div className="flex flex-col gap-6">
            <p className="text-xs text-muted-foreground leading-relaxed">
                Override system prompt controls, AGENTS.md inclusion, and MCP server availability for
                sessions that <span className="text-foreground">start</span> on a specific model provider.
                Fields left on &ldquo;Inherit&rdquo; use this runner&rsquo;s global settings.
            </p>

            {/* ── Per-provider cards ───────────────────────────────── */}
            {providerNames.map((provider) => {
                const draft = drafts[provider];
                return (
                    <div
                        key={provider}
                        className="flex flex-col gap-4 rounded-md border border-border bg-muted/30 p-4"
                    >
                        <div className="flex items-center justify-between">
                            <span className="flex items-center gap-2 text-sm font-medium font-mono">
                                <Layers className="h-4 w-4 text-muted-foreground" />
                                {provider}
                            </span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => removeProvider(provider)}
                                aria-label={`Remove overrides for ${provider}`}
                            >
                                <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                            </Button>
                        </div>

                        <div className="flex items-center justify-between">
                            <Label htmlFor={`builtin-${provider}`} className="text-xs">
                                Built-in System Prompt
                            </Label>
                            <TriStateSelect
                                id={`builtin-${provider}`}
                                value={draft.builtinSystemPrompt}
                                onChange={(v) => updateDraft(provider, { builtinSystemPrompt: v })}
                            />
                        </div>

                        <div className="flex items-center justify-between">
                            <Label htmlFor={`agentsmd-${provider}`} className="text-xs">
                                Send AGENTS.md Context
                            </Label>
                            <TriStateSelect
                                id={`agentsmd-${provider}`}
                                value={draft.sendAgentsMd}
                                onChange={(v) => updateDraft(provider, { sendAgentsMd: v })}
                            />
                        </div>

                        <div className="flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                                <Label htmlFor={`append-toggle-${provider}`} className="text-xs">
                                    Override Append System Prompt
                                </Label>
                                <Switch
                                    id={`append-toggle-${provider}`}
                                    checked={draft.appendOverride}
                                    onCheckedChange={(v) => updateDraft(provider, { appendOverride: v })}
                                />
                            </div>
                            {draft.appendOverride && (
                                <Textarea
                                    value={draft.appendSystemPrompt}
                                    onChange={(e) => updateDraft(provider, { appendSystemPrompt: e.target.value })}
                                    placeholder="Replaces the global append prompt for this provider. Leave empty to append nothing."
                                    className="font-mono text-xs min-h-[80px] resize-y bg-muted/50 border-border"
                                />
                            )}
                        </div>

                        <div className="flex flex-col gap-2">
                            <Label htmlFor={`mcp-${provider}`} className="text-xs">
                                Disabled MCP Servers
                            </Label>
                            <Input
                                id={`mcp-${provider}`}
                                value={draft.disabledMcpServers}
                                onChange={(e) => updateDraft(provider, { disabledMcpServers: e.target.value })}
                                placeholder="server-one, server-two"
                                className="font-mono text-xs h-8"
                            />
                            <p className="text-[10px] text-muted-foreground">
                                Comma-separated. Disabled in addition to the global/project lists.
                            </p>
                        </div>
                    </div>
                );
            })}

            {/* ── Add provider ─────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
                <Label htmlFor="new-provider" className="text-sm font-medium">
                    Add Provider Override
                </Label>
                <div className="flex gap-2">
                    <Input
                        id="new-provider"
                        list="provider-suggestions"
                        value={newProvider}
                        onChange={(e) => setNewProvider(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                addProvider();
                            }
                        }}
                        placeholder="e.g. anthropic, claude-subscription"
                        className="font-mono text-sm flex-1 max-w-sm"
                    />
                    <datalist id="provider-suggestions">
                        {suggestions.map((p) => (
                            <option key={p} value={p} />
                        ))}
                    </datalist>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addProvider}
                        disabled={!newProvider.trim() || newProvider.trim() in drafts}
                    >
                        <Plus className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* ── Notes ────────────────────────────────────────────── */}
            <div className="flex flex-col gap-1.5 rounded-md bg-muted/40 border border-border px-3 py-2.5 text-xs text-muted-foreground">
                <p className="flex items-start gap-1.5">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    The provider is resolved once at session start (spawned model, otherwise the default
                    provider). Mid-session model switches do not re-apply overrides.
                </p>
                <p className="flex items-start gap-1.5">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    Changes apply on next session start.
                </p>
            </div>

            {/* ── Save ─────────────────────────────────────────────── */}
            <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving} size="sm">
                    <Save className="h-4 w-4 mr-1.5" />
                    {saving ? "Saving…" : "Save"}
                </Button>
            </div>
        </div>
    );
}
