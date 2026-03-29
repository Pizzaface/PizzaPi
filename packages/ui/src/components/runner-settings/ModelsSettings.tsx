import { useState, useEffect, useMemo } from "react";
import { Loader2, Save, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { SectionProps } from "./RunnerSettingsPanel";

interface ModelInfo {
    provider: string;
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
}

const THINKING_LEVELS = ["none", "low", "medium", "high"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export default function ModelsSettings({ runnerId, tuiSettings, onSave, saving }: SectionProps) {
    // Form state — initialized from tuiSettings
    const [defaultProvider, setDefaultProvider] = useState<string>(tuiSettings.defaultProvider ?? "");
    const [defaultModel, setDefaultModel] = useState<string>(tuiSettings.defaultModel ?? "");
    const [defaultThinkingLevel, setDefaultThinkingLevel] = useState<ThinkingLevel>(
        (tuiSettings.defaultThinkingLevel as ThinkingLevel) ?? "none",
    );

    // Models fetched from the runner
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [loadingModels, setLoadingModels] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);

    // Re-sync form state if props change (e.g. after external save)
    useEffect(() => {
        setDefaultProvider(tuiSettings.defaultProvider ?? "");
        setDefaultModel(tuiSettings.defaultModel ?? "");
        setDefaultThinkingLevel((tuiSettings.defaultThinkingLevel as ThinkingLevel) ?? "none");
    }, [tuiSettings]);

    // Fetch available models
    useEffect(() => {
        let cancelled = false;
        async function fetchModels() {
            setLoadingModels(true);
            setFetchError(null);
            try {
                const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/models`);
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.error ?? `HTTP ${res.status}`);
                }
                const data = await res.json();
                if (!cancelled) {
                    setModels(data.models ?? []);
                }
            } catch (err: any) {
                if (!cancelled) {
                    setFetchError(err.message ?? "Failed to fetch models");
                }
            } finally {
                if (!cancelled) setLoadingModels(false);
            }
        }
        fetchModels();
        return () => {
            cancelled = true;
        };
    }, [runnerId]);

    // Derived: unique providers
    const providers = useMemo(() => {
        const set = new Set(models.map((m) => m.provider));
        return Array.from(set).sort();
    }, [models]);

    // Derived: models for the selected provider
    const filteredModels = useMemo(
        () => (defaultProvider ? models.filter((m) => m.provider === defaultProvider) : models),
        [models, defaultProvider],
    );

    // When provider changes, reset model if it doesn't belong to the new provider
    const handleProviderChange = (value: string) => {
        setDefaultProvider(value);
        const stillValid = models.some((m) => m.provider === value && m.id === defaultModel);
        if (!stillValid) {
            setDefaultModel("");
        }
    };

    const handleSave = () => {
        onSave("models", { defaultProvider, defaultModel, defaultThinkingLevel });
    };

    const isDirty =
        defaultProvider !== (tuiSettings.defaultProvider ?? "") ||
        defaultModel !== (tuiSettings.defaultModel ?? "") ||
        defaultThinkingLevel !== ((tuiSettings.defaultThinkingLevel as string) ?? "none");

    return (
        <div className="flex flex-col gap-6">
            {/* Loading / error state for models fetch */}
            {loadingModels && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    Loading available models…
                </div>
            )}
            {fetchError && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    Failed to load models: {fetchError}
                </div>
            )}

            {/* Provider select */}
            <div className="flex flex-col gap-2">
                <Label htmlFor="default-provider">Default Provider</Label>
                <Select value={defaultProvider} onValueChange={handleProviderChange} disabled={loadingModels}>
                    <SelectTrigger id="default-provider" className="w-full max-w-sm">
                        <SelectValue placeholder="Select a provider…" />
                    </SelectTrigger>
                    <SelectContent>
                        {providers.map((p) => (
                            <SelectItem key={p} value={p}>
                                {p}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {/* Model select */}
            <div className="flex flex-col gap-2">
                <Label htmlFor="default-model">Default Model</Label>
                <Select
                    value={defaultModel}
                    onValueChange={setDefaultModel}
                    disabled={loadingModels || !defaultProvider}
                >
                    <SelectTrigger id="default-model" className="w-full max-w-sm">
                        <SelectValue placeholder={defaultProvider ? "Select a model…" : "Choose a provider first"} />
                    </SelectTrigger>
                    <SelectContent>
                        {filteredModels.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                                <span>{m.name || m.id}</span>
                                {m.contextWindow > 0 && (
                                    <span className="ml-2 text-xs text-muted-foreground">
                                        {Math.round(m.contextWindow / 1000)}k ctx
                                    </span>
                                )}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {/* Thinking level */}
            <div className="flex flex-col gap-2">
                <Label htmlFor="thinking-level">Default Thinking Level</Label>
                <Select
                    value={defaultThinkingLevel}
                    onValueChange={(v) => setDefaultThinkingLevel(v as ThinkingLevel)}
                >
                    <SelectTrigger id="thinking-level" className="w-full max-w-sm">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {THINKING_LEVELS.map((level) => (
                            <SelectItem key={level} value={level}>
                                {level.charAt(0).toUpperCase() + level.slice(1)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {/* Info note */}
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" />
                <span>Changes apply on next session start.</span>
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
