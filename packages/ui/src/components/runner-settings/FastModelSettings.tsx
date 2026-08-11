import { useState, useEffect, useMemo } from "react";
import { Loader2, Save, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type { SectionProps } from "./RunnerSettingsPanel";

/** Shape of the `goal` section in ~/.pizzapi/config.json. */
interface GoalConfig {
    evaluatorModel?: string;
    evaluatorMaxTokens?: number;
    evaluateEveryNTurns?: number;
    minTurnsBeforeEvaluate?: number;
}

interface ModelInfo {
    provider: string;
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
}

const DEFAULT_MAX_TOKENS = 512;
const MIN_TOKENS = 1;
const MAX_TOKENS = 4096;
// Keep in sync with the CLI: DEFAULT_EVALUATE_EVERY_N_TURNS in
// packages/cli/src/extensions/goal/evaluator.ts and
// DEFAULT_MIN_TURNS_BEFORE_EVALUATE in .../goal/types.ts. Both are measured
// in completed agent runs, not LLM round-trips.
const DEFAULT_EVALUATE_EVERY_N_TURNS = 1;
const MIN_EVALUATE_EVERY_N_TURNS = 1;
const DEFAULT_MIN_TURNS_BEFORE_EVALUATE = 1;
const MIN_MIN_TURNS_BEFORE_EVALUATE = 0;

/**
 * Parse a stored evaluatorModel value into provider + modelId.
 * The config accepts either "provider:modelId" or just "modelId".
 */
export function parseEvaluatorModel(model?: string): { provider: string; modelId: string } {
    if (!model) return { provider: "", modelId: "" };
    const parts = model.split(":");
    if (parts.length === 2 && parts[0] && parts[1]) {
        return { provider: parts[0], modelId: parts[1] };
    }
    return { provider: "", modelId: model };
}

/**
 * Fast Model settings for the `/goal` evaluator.
 *
 * Lets the user pick a small, fast model (provider + model) and a max output
 * token budget used when the goal evaluator calls the LLM.
 */
export default function FastModelSettings({ runnerId, config, onSave, saving }: SectionProps) {
    const goalConfig = (config.goal ?? {}) as GoalConfig;

    // Parse the persisted model string so the dropdowns can be pre-filled.
    const initialModel = useMemo(() => parseEvaluatorModel(goalConfig.evaluatorModel), [goalConfig.evaluatorModel]);

    // Form state
    const [provider, setProvider] = useState<string>(initialModel.provider);
    const [modelId, setModelId] = useState<string>(initialModel.modelId);
    const [maxTokens, setMaxTokens] = useState<number>(goalConfig.evaluatorMaxTokens ?? DEFAULT_MAX_TOKENS);
    const [evaluateEveryNTurns, setEvaluateEveryNTurns] = useState<number>(
        goalConfig.evaluateEveryNTurns ?? DEFAULT_EVALUATE_EVERY_N_TURNS,
    );
    const [minTurnsBeforeEvaluate, setMinTurnsBeforeEvaluate] = useState<number>(
        goalConfig.minTurnsBeforeEvaluate ?? DEFAULT_MIN_TURNS_BEFORE_EVALUATE,
    );

    // Available models fetched from the runner
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [loadingModels, setLoadingModels] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);

    // Re-sync form state if the saved config changes (e.g. after a save or refresh)
    useEffect(() => {
        const parsed = parseEvaluatorModel(goalConfig.evaluatorModel);
        setProvider(parsed.provider);
        setModelId(parsed.modelId);
        setMaxTokens(goalConfig.evaluatorMaxTokens ?? DEFAULT_MAX_TOKENS);
        setEvaluateEveryNTurns(goalConfig.evaluateEveryNTurns ?? DEFAULT_EVALUATE_EVERY_N_TURNS);
        setMinTurnsBeforeEvaluate(goalConfig.minTurnsBeforeEvaluate ?? DEFAULT_MIN_TURNS_BEFORE_EVALUATE);
    }, [goalConfig.evaluatorModel, goalConfig.evaluatorMaxTokens, goalConfig.evaluateEveryNTurns, goalConfig.minTurnsBeforeEvaluate]);

    // Fetch available models from the runner
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

    // Unique, sorted providers
    const providers = useMemo(() => {
        const set = new Set(models.map((m) => m.provider));
        return Array.from(set).sort();
    }, [models]);

    // Models available for the selected provider
    const filteredModels = useMemo(
        () => (provider ? models.filter((m) => m.provider === provider) : []),
        [models, provider],
    );

    // When the provider changes, reset the model if it is no longer valid
    const handleProviderChange = (value: string) => {
        setProvider(value);
        const stillValid = models.some((m) => m.provider === value && m.id === modelId);
        if (!stillValid) {
            setModelId("");
        }
    };

    // Clamp max tokens to a sensible range
    const handleMaxTokensChange = (value: string) => {
        const parsed = Number(value);
        if (Number.isNaN(parsed)) {
            setMaxTokens(0);
            return;
        }
        setMaxTokens(Math.max(MIN_TOKENS, Math.min(MAX_TOKENS, Math.round(parsed))));
    };

    const handleEvaluateEveryChange = (value: string) => {
        const parsed = Number(value);
        if (Number.isNaN(parsed)) {
            setEvaluateEveryNTurns(0);
            return;
        }
        setEvaluateEveryNTurns(Math.max(MIN_EVALUATE_EVERY_N_TURNS, Math.round(parsed)));
    };

    const handleMinTurnsChange = (value: string) => {
        const parsed = Number(value);
        if (Number.isNaN(parsed)) {
            setMinTurnsBeforeEvaluate(0);
            return;
        }
        setMinTurnsBeforeEvaluate(Math.max(MIN_MIN_TURNS_BEFORE_EVALUATE, Math.round(parsed)));
    };

    const handleSave = () => {
        const value: GoalConfig = {
            evaluatorModel: provider && modelId ? `${provider}:${modelId}` : modelId || undefined,
            evaluatorMaxTokens: maxTokens || undefined,
            evaluateEveryNTurns: evaluateEveryNTurns === DEFAULT_EVALUATE_EVERY_N_TURNS ? undefined : evaluateEveryNTurns,
            minTurnsBeforeEvaluate:
                minTurnsBeforeEvaluate === DEFAULT_MIN_TURNS_BEFORE_EVALUATE ? undefined : minTurnsBeforeEvaluate,
        };
        onSave("goal", value);
    };

    const isDirty =
        provider !== initialModel.provider ||
        modelId !== initialModel.modelId ||
        maxTokens !== (goalConfig.evaluatorMaxTokens ?? DEFAULT_MAX_TOKENS) ||
        evaluateEveryNTurns !== (goalConfig.evaluateEveryNTurns ?? DEFAULT_EVALUATE_EVERY_N_TURNS) ||
        minTurnsBeforeEvaluate !== (goalConfig.minTurnsBeforeEvaluate ?? DEFAULT_MIN_TURNS_BEFORE_EVALUATE);

    const canSave =
        !saving && provider && modelId && maxTokens >= MIN_TOKENS && evaluateEveryNTurns >= MIN_EVALUATE_EVERY_N_TURNS &&
        minTurnsBeforeEvaluate >= MIN_MIN_TURNS_BEFORE_EVALUATE;

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
                <Label htmlFor="evaluator-provider">Provider</Label>
                <Select value={provider} onValueChange={handleProviderChange} disabled={loadingModels}>
                    <SelectTrigger id="evaluator-provider" className="w-full max-w-sm">
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
                <Label htmlFor="evaluator-model">Model</Label>
                <Select value={modelId} onValueChange={setModelId} disabled={loadingModels || !provider}>
                    <SelectTrigger id="evaluator-model" className="w-full max-w-sm">
                        <SelectValue placeholder={provider ? "Select a model…" : "Choose a provider first"} />
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

            {/* Max tokens input */}
            <div className="flex flex-col gap-2">
                <Label htmlFor="evaluator-max-tokens">Max Tokens</Label>
                <Input
                    id="evaluator-max-tokens"
                    type="number"
                    min={MIN_TOKENS}
                    max={MAX_TOKENS}
                    value={maxTokens}
                    onChange={(e) => handleMaxTokensChange(e.target.value)}
                    className="w-full max-w-sm"
                />
                <p className="text-xs text-muted-foreground">
                    Maximum output tokens for the goal evaluator. Default: {DEFAULT_MAX_TOKENS}.
                </p>
            </div>

            {/* Evaluate cadence */}
            <div className="flex flex-col gap-2">
                <Label htmlFor="evaluator-every-n-turns">Evaluate Every N Runs</Label>
                <Input
                    id="evaluator-every-n-turns"
                    type="number"
                    min={MIN_EVALUATE_EVERY_N_TURNS}
                    value={evaluateEveryNTurns}
                    onChange={(e) => handleEvaluateEveryChange(e.target.value)}
                    className="w-full max-w-sm"
                />
                <p className="text-xs text-muted-foreground">
                    Run the LLM evaluator once every N completed agent runs — one prompt through to control returning to you, not each tool call. Set to 1 to evaluate every run. Default: {DEFAULT_EVALUATE_EVERY_N_TURNS}.
                </p>
            </div>

            {/* Minimum turns before first evaluation */}
            <div className="flex flex-col gap-2">
                <Label htmlFor="evaluator-min-turns">Minimum Runs Before Evaluating</Label>
                <Input
                    id="evaluator-min-turns"
                    type="number"
                    min={MIN_MIN_TURNS_BEFORE_EVALUATE}
                    value={minTurnsBeforeEvaluate}
                    onChange={(e) => handleMinTurnsChange(e.target.value)}
                    className="w-full max-w-sm"
                />
                <p className="text-xs text-muted-foreground">
                    Wait for this many completed agent runs before the goal evaluator runs for the first time. Default: {DEFAULT_MIN_TURNS_BEFORE_EVALUATE}.
                </p>
            </div>

            {/* Info note */}
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" />
                <span>Changes apply on next session start.</span>
            </div>

            {/* Save button */}
            <div>
                <Button onClick={handleSave} disabled={!canSave || !isDirty} className="gap-2">
                    {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                    Save
                </Button>
            </div>
        </div>
    );
}
