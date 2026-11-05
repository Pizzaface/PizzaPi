import { useState, useEffect } from "react";
import { Loader2, Save, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SectionProps } from "./RunnerSettingsPanel";
import { isRunnerChatModel } from "@/lib/message-helpers";

/** Shape of the `goal` section in ~/.pizzapi/config.json. */
interface GoalConfig {
    evaluatorModel?: string;
    evaluatorMaxTokens?: number;
    evaluateEveryNTurns?: number;
    minTurnsBeforeEvaluate?: number;
}

/** Select value for "no pinned model" (Radix Select can't use ""). */
const SESSION_MODEL = "__session__";

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
 * Build the `goal` config patch this panel saves. The daemon replaces the
 * whole `goal` object, so an unset `evaluatorModel` clears any pinned model.
 */
export function buildGoalConfigPatch(input: {
    evaluatorModel: string;
    maxTokens: number;
    evaluateEveryNTurns: number;
    minTurnsBeforeEvaluate: number;
}): GoalConfig {
    return {
        evaluatorModel: input.evaluatorModel && input.evaluatorModel !== SESSION_MODEL ? input.evaluatorModel : undefined,
        evaluatorMaxTokens: input.maxTokens || undefined,
        evaluateEveryNTurns:
            input.evaluateEveryNTurns === DEFAULT_EVALUATE_EVERY_N_TURNS ? undefined : input.evaluateEveryNTurns,
        minTurnsBeforeEvaluate:
            input.minTurnsBeforeEvaluate === DEFAULT_MIN_TURNS_BEFORE_EVALUATE ? undefined : input.minTurnsBeforeEvaluate,
    };
}

/**
 * Goal evaluator settings.
 *
 * The default ("Session model") appends the judge question to the session's
 * own context so the provider's prompt cache serves the conversation. Pinning
 * a model opts out of that and sends a standalone, truncated transcript.
 */
export default function GoalEvaluatorSettings({ runnerId, config, onSave, saving }: SectionProps) {
    const goalConfig = (config.goal ?? {}) as GoalConfig;
    const savedModel = goalConfig.evaluatorModel || SESSION_MODEL;

    // Form state
    const [evaluatorModel, setEvaluatorModel] = useState<string>(savedModel);
    const [models, setModels] = useState<{ provider: string; id: string; name?: string }[]>([]);
    const [modelsError, setModelsError] = useState<string | null>(null);
    const [maxTokens, setMaxTokens] = useState<number>(goalConfig.evaluatorMaxTokens ?? DEFAULT_MAX_TOKENS);
    const [evaluateEveryNTurns, setEvaluateEveryNTurns] = useState<number>(
        goalConfig.evaluateEveryNTurns ?? DEFAULT_EVALUATE_EVERY_N_TURNS,
    );
    const [minTurnsBeforeEvaluate, setMinTurnsBeforeEvaluate] = useState<number>(
        goalConfig.minTurnsBeforeEvaluate ?? DEFAULT_MIN_TURNS_BEFORE_EVALUATE,
    );

    // Re-sync form state if the saved config changes (e.g. after a save or refresh)
    useEffect(() => {
        let cancelled = false;
        fetch(`/api/runners/${encodeURIComponent(runnerId)}/models`)
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (!cancelled) setModels(Array.isArray(data.models) ? data.models.filter(isRunnerChatModel) : []);
            })
            .catch((err) => {
                if (!cancelled) setModelsError(err instanceof Error ? err.message : String(err));
            });
        return () => {
            cancelled = true;
        };
    }, [runnerId]);

    useEffect(() => {
        setEvaluatorModel(savedModel);
        setMaxTokens(goalConfig.evaluatorMaxTokens ?? DEFAULT_MAX_TOKENS);
        setEvaluateEveryNTurns(goalConfig.evaluateEveryNTurns ?? DEFAULT_EVALUATE_EVERY_N_TURNS);
        setMinTurnsBeforeEvaluate(goalConfig.minTurnsBeforeEvaluate ?? DEFAULT_MIN_TURNS_BEFORE_EVALUATE);
    }, [savedModel, goalConfig.evaluatorMaxTokens, goalConfig.evaluateEveryNTurns, goalConfig.minTurnsBeforeEvaluate]);

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
        onSave(
            "goal",
            buildGoalConfigPatch({
                evaluatorModel,
                maxTokens,
                evaluateEveryNTurns,
                minTurnsBeforeEvaluate,
            }),
        );
    };

    const isDirty =
        evaluatorModel !== savedModel ||
        maxTokens !== (goalConfig.evaluatorMaxTokens ?? DEFAULT_MAX_TOKENS) ||
        evaluateEveryNTurns !== (goalConfig.evaluateEveryNTurns ?? DEFAULT_EVALUATE_EVERY_N_TURNS) ||
        minTurnsBeforeEvaluate !== (goalConfig.minTurnsBeforeEvaluate ?? DEFAULT_MIN_TURNS_BEFORE_EVALUATE);

    const canSave =
        !saving && maxTokens >= MIN_TOKENS && evaluateEveryNTurns >= MIN_EVALUATE_EVERY_N_TURNS &&
        minTurnsBeforeEvaluate >= MIN_MIN_TURNS_BEFORE_EVALUATE;

    const modelOptions = models.map((m) => `${m.provider}:${m.id}`);
    // Keep a pinned model selectable even if this runner no longer lists it.
    if (evaluatorModel !== SESSION_MODEL && !modelOptions.includes(evaluatorModel)) modelOptions.unshift(evaluatorModel);

    return (
        <div className="flex flex-col gap-6">
            {/* Evaluator model */}
            <div className="flex flex-col gap-2">
                <Label htmlFor="evaluator-model">Evaluator Model</Label>
                <Select value={evaluatorModel} onValueChange={setEvaluatorModel}>
                    <SelectTrigger id="evaluator-model" className="w-full max-w-sm">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={SESSION_MODEL}>Session model (uses prompt cache)</SelectItem>
                        {modelOptions.map((value) => (
                            <SelectItem key={value} value={value}>
                                {value}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                    {modelsError
                        ? `Failed to load models: ${modelsError}`
                        : "Default: the session's own model, which reads the conversation from the provider's prompt cache. Pinning a model sends it a standalone, truncated transcript instead."}
                </p>
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
                <span>
                    Changes apply on next session start.
                </span>
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
