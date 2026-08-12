import { useState, useEffect } from "react";
import { Loader2, Save, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SectionProps } from "./RunnerSettingsPanel";

/** Shape of the `goal` section in ~/.pizzapi/config.json. */
interface GoalConfig {
    evaluatorModel?: string;
    evaluatorMaxTokens?: number;
    evaluateEveryNTurns?: number;
    minTurnsBeforeEvaluate?: number;
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
 * Build the `goal` config patch this panel saves.
 *
 * Pulled out of the component so the preservation rule below is testable
 * without driving the form: the panel no longer edits `evaluatorModel`, but a
 * save must not drop one the user set by hand in config.json.
 */
export function buildGoalConfigPatch(input: {
    existing: GoalConfig;
    maxTokens: number;
    evaluateEveryNTurns: number;
    minTurnsBeforeEvaluate: number;
}): GoalConfig {
    return {
        evaluatorModel: input.existing.evaluatorModel,
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
 * There is deliberately no model picker: the evaluator appends its judge
 * question to the session's own context and calls the session's model, so the
 * conversation is served from the provider's prompt cache instead of being
 * re-sent as a fresh transcript. Choosing a different model here would opt
 * out of that, which is why the escape hatch stays in `goal.evaluatorModel`
 * for the rare case that needs it (e.g. a local/private judge).
 */
export default function GoalEvaluatorSettings({ config, onSave, saving }: SectionProps) {
    const goalConfig = (config.goal ?? {}) as GoalConfig;

    // Form state
    const [maxTokens, setMaxTokens] = useState<number>(goalConfig.evaluatorMaxTokens ?? DEFAULT_MAX_TOKENS);
    const [evaluateEveryNTurns, setEvaluateEveryNTurns] = useState<number>(
        goalConfig.evaluateEveryNTurns ?? DEFAULT_EVALUATE_EVERY_N_TURNS,
    );
    const [minTurnsBeforeEvaluate, setMinTurnsBeforeEvaluate] = useState<number>(
        goalConfig.minTurnsBeforeEvaluate ?? DEFAULT_MIN_TURNS_BEFORE_EVALUATE,
    );

    // Re-sync form state if the saved config changes (e.g. after a save or refresh)
    useEffect(() => {
        setMaxTokens(goalConfig.evaluatorMaxTokens ?? DEFAULT_MAX_TOKENS);
        setEvaluateEveryNTurns(goalConfig.evaluateEveryNTurns ?? DEFAULT_EVALUATE_EVERY_N_TURNS);
        setMinTurnsBeforeEvaluate(goalConfig.minTurnsBeforeEvaluate ?? DEFAULT_MIN_TURNS_BEFORE_EVALUATE);
    }, [goalConfig.evaluatorMaxTokens, goalConfig.evaluateEveryNTurns, goalConfig.minTurnsBeforeEvaluate]);

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
                existing: goalConfig,
                maxTokens,
                evaluateEveryNTurns,
                minTurnsBeforeEvaluate,
            }),
        );
    };

    const isDirty =
        maxTokens !== (goalConfig.evaluatorMaxTokens ?? DEFAULT_MAX_TOKENS) ||
        evaluateEveryNTurns !== (goalConfig.evaluateEveryNTurns ?? DEFAULT_EVALUATE_EVERY_N_TURNS) ||
        minTurnsBeforeEvaluate !== (goalConfig.minTurnsBeforeEvaluate ?? DEFAULT_MIN_TURNS_BEFORE_EVALUATE);

    const canSave =
        !saving && maxTokens >= MIN_TOKENS && evaluateEveryNTurns >= MIN_EVALUATE_EVERY_N_TURNS &&
        minTurnsBeforeEvaluate >= MIN_MIN_TURNS_BEFORE_EVALUATE;

    return (
        <div className="flex flex-col gap-6">
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
                    The evaluator runs on your session&rsquo;s own model, reusing the conversation already cached by the
                    provider — so there is no separate model to choose. Changes apply on next session start.
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
