import * as React from "react";
import { cn } from "@/lib/utils";
import { MessageCircleQuestion, PenLine, Send, Check, ArrowLeft, ArrowRight, GripVertical, ArrowUp, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QuestionType } from "@/lib/ask-user-questions";

export interface MultipleChoiceQuestion {
  question: string;
  options: string[];
  type?: QuestionType;
}

/** Answer payload: array of { question, answer } tuples (preserves order, handles duplicate questions). */
export type MultipleChoiceAnswers = Array<{ question: string; answer: string }>;

export interface MultipleChoiceQuestionsProps {
  questions: MultipleChoiceQuestion[];
  /** Stable identity for this prompt (e.g. toolCallId). Used to reset selections on new prompt. */
  promptKey?: string;
  onSubmit: (answers: MultipleChoiceAnswers) => void | Promise<boolean | void>;
  className?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getQuestionType(q: MultipleChoiceQuestion): QuestionType {
  return q.type ?? "radio";
}

/**
 * Stepper-style multiple-choice question panel that replaces the text input
 * when the agent asks one or more questions.
 *
 * Supports three question types:
 * - "radio"    — single-select (default, backward-compatible)
 * - "checkbox" — multi-select (at least one required)
 * - "ranked"   — drag-to-reorder ranked choice
 */
export function MultipleChoiceQuestions({
  questions,
  promptKey,
  onSubmit,
  className,
}: MultipleChoiceQuestionsProps) {
  // ── Radio state: selected option index per question ────────────────────────
  const [selections, setSelections] = React.useState<Map<number, number>>(new Map());

  // ── Checkbox state: set of selected option indices per question ─────────────
  const [checkboxSelections, setCheckboxSelections] = React.useState<Map<number, Set<number>>>(new Map());

  // ── Ranked state: ordered array of option indices per question ──────────────
  const [rankedOrders, setRankedOrders] = React.useState<Map<number, number[]>>(new Map());

  // ── Shared state ───────────────────────────────────────────────────────────
  const [customTexts, setCustomTexts] = React.useState<Map<number, string>>(new Map());
  const [currentStep, setCurrentStep] = React.useState(0);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const submitTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drag state for ranked questions
  const [dragIdx, setDragIdx] = React.useState<number | null>(null);

  // Reset state when the prompt identity changes
  React.useEffect(() => {
    setSelections(new Map());
    setCheckboxSelections(new Map());
    setRankedOrders(new Map());
    setCustomTexts(new Map());
    setCurrentStep(0);
    setIsSubmitting(false);
    setDragIdx(null);
    if (submitTimeoutRef.current !== null) {
      clearTimeout(submitTimeoutRef.current);
      submitTimeoutRef.current = null;
    }
  }, [promptKey]);

  React.useEffect(() => {
    if (currentStep >= questions.length) {
      setCurrentStep(Math.max(questions.length - 1, 0));
    }
  }, [currentStep, questions.length]);

  // ── "Is answered?" logic per type ──────────────────────────────────────────

  const isQuestionAnswered = (idx: number) => {
    const q = questions[idx];
    if (!q) return false;
    const type = getQuestionType(q);

    if (type === "ranked") {
      // Ranked is answered once the user has an ordering (auto-initialized)
      const order = rankedOrders.get(idx);
      return !!order && order.length > 0;
    }

    if (type === "checkbox") {
      const checked = checkboxSelections.get(idx);
      if (!checked || checked.size === 0) return false;
      // If "write your own" is checked, require text
      if (checked.has(q.options.length)) return (customTexts.get(idx) ?? "").trim().length > 0;
      return true;
    }

    // Radio
    const sel = selections.get(idx);
    if (sel === undefined || sel === null) return false;
    if (sel === q.options.length) return (customTexts.get(idx) ?? "").trim().length > 0;
    return true;
  };

  const allAnswered = questions.every((_, idx) => isQuestionAnswered(idx));
  const currentQuestionAnswered = isQuestionAnswered(currentStep);
  const isLastStep = currentStep >= questions.length - 1;

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleRadioSelect = (qIdx: number, optIdx: number) => {
    setSelections((prev) => {
      const next = new Map(prev);
      next.set(qIdx, optIdx);
      return next;
    });
  };

  const handleCheckboxToggle = (qIdx: number, optIdx: number) => {
    setCheckboxSelections((prev) => {
      const next = new Map(prev);
      const current = new Set(prev.get(qIdx) ?? []);
      if (current.has(optIdx)) {
        current.delete(optIdx);
      } else {
        current.add(optIdx);
      }
      next.set(qIdx, current);
      return next;
    });
  };

  const handleCustomText = (qIdx: number, text: string) => {
    setCustomTexts((prev) => {
      const next = new Map(prev);
      next.set(qIdx, text);
      return next;
    });
  };

  // Initialize ranked order when the question first renders
  const ensureRankedOrder = React.useCallback((qIdx: number, optionCount: number) => {
    setRankedOrders((prev) => {
      if (prev.has(qIdx)) return prev;
      const next = new Map(prev);
      next.set(qIdx, Array.from({ length: optionCount }, (_, i) => i));
      return next;
    });
  }, []);

  const handleRankedMove = (qIdx: number, fromPos: number, toPos: number) => {
    setRankedOrders((prev) => {
      const order = [...(prev.get(qIdx) ?? [])];
      if (fromPos < 0 || fromPos >= order.length || toPos < 0 || toPos >= order.length) return prev;
      const [item] = order.splice(fromPos, 1);
      order.splice(toPos, 0, item);
      const next = new Map(prev);
      next.set(qIdx, order);
      return next;
    });
  };

  const handleNext = () => {
    if (!currentQuestionAnswered) return;
    setCurrentStep((prev) => Math.min(prev + 1, questions.length - 1));
  };

  const handleBack = () => {
    setCurrentStep((prev) => Math.max(prev - 1, 0));
  };

  // ── Build answer string per question type ──────────────────────────────────

  const buildAnswer = (q: MultipleChoiceQuestion, qIdx: number): string => {
    const type = getQuestionType(q);

    if (type === "ranked") {
      const order = rankedOrders.get(qIdx) ?? [];
      return order.map((optIdx, rank) => `${rank + 1}. ${q.options[optIdx]}`).join(", ");
    }

    if (type === "checkbox") {
      const checked = checkboxSelections.get(qIdx) ?? new Set<number>();
      const parts: string[] = [];
      for (const optIdx of checked) {
        if (optIdx === q.options.length) {
          parts.push((customTexts.get(qIdx) ?? "").trim());
        } else {
          parts.push(q.options[optIdx]);
        }
      }
      return parts.join(", ");
    }

    // Radio
    const sel = selections.get(qIdx)!;
    return sel === q.options.length
      ? (customTexts.get(qIdx) ?? "").trim()
      : q.options[sel];
  };

  const handleSubmit = () => {
    if (!allAnswered || isSubmitting) return;
    setIsSubmitting(true);
    const answers: MultipleChoiceAnswers = questions.map((q, i) => ({
      question: q.question,
      answer: buildAnswer(q, i),
    }));

    if (submitTimeoutRef.current !== null) clearTimeout(submitTimeoutRef.current);
    submitTimeoutRef.current = setTimeout(() => {
      submitTimeoutRef.current = null;
      setIsSubmitting(false);
    }, 10_000);

    Promise.resolve(onSubmit(answers))
      .then((result) => {
        if (result === false) {
          if (submitTimeoutRef.current !== null) { clearTimeout(submitTimeoutRef.current); submitTimeoutRef.current = null; }
          setIsSubmitting(false);
        }
      })
      .catch(() => {
        if (submitTimeoutRef.current !== null) { clearTimeout(submitTimeoutRef.current); submitTimeoutRef.current = null; }
        setIsSubmitting(false);
      });
  };

  // ── Render helpers ─────────────────────────────────────────────────────────

  const renderRadioQuestion = (q: MultipleChoiceQuestion, qIdx: number) => {
    const selected = selections.get(qIdx);
    const writeYourOwnIdx = q.options.length;
    const isCustom = selected === writeYourOwnIdx;
    const groupName = `mc-q-${promptKey ?? "default"}-${qIdx}`;

    const visibleOptions = q.options
      .map((option, origIdx) => ({ option, origIdx }))
      .filter(({ option }) => option.toLowerCase().replace(/[^a-z]/g, "") !== "typeyourown");

    return (
      <div className="space-y-1.5" role="radiogroup" aria-label={q.question}>
        {visibleOptions.map(({ option, origIdx }, displayIdx) => {
          const isSelected = selected === origIdx;
          const inputId = `${groupName}-opt-${origIdx}`;
          return (
            <label key={origIdx} htmlFor={inputId} className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm cursor-pointer transition-all",
              isSelected
                ? "border border-violet-500/40 bg-violet-500/15 text-violet-100"
                : "border border-transparent hover:border-violet-500/20 hover:bg-violet-500/[0.07] text-foreground/70 hover:text-foreground/90",
            )}>
              <input type="radio" id={inputId} name={groupName} value={option} checked={isSelected}
                onChange={() => handleRadioSelect(qIdx, origIdx)} className="sr-only" />
              <span className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-full border transition-all",
                isSelected ? "border-violet-400 bg-violet-500" : "border-violet-500/30 bg-transparent",
              )} aria-hidden="true">
                {isSelected && <Check className="size-2.5 text-white" strokeWidth={3} />}
              </span>
              <span className="flex items-center gap-1.5">
                <span className={cn(
                  "flex size-4 items-center justify-center rounded text-[10px] font-medium shrink-0",
                  isSelected ? "bg-violet-500/30 text-violet-200" : "bg-violet-500/15 text-violet-300/70",
                )} aria-hidden="true">{String.fromCharCode(65 + displayIdx)}</span>
                <span className="text-left leading-snug">{option}</span>
              </span>
            </label>
          );
        })}

        {renderWriteYourOwn(qIdx, groupName, isCustom, "radio")}

        {isCustom && renderCustomInput(qIdx, q.question)}
      </div>
    );
  };

  const renderCheckboxQuestion = (q: MultipleChoiceQuestion, qIdx: number) => {
    const checked = checkboxSelections.get(qIdx) ?? new Set<number>();
    const writeYourOwnIdx = q.options.length;
    const isCustomChecked = checked.has(writeYourOwnIdx);
    const groupName = `mc-q-${promptKey ?? "default"}-${qIdx}`;

    const visibleOptions = q.options
      .map((option, origIdx) => ({ option, origIdx }))
      .filter(({ option }) => option.toLowerCase().replace(/[^a-z]/g, "") !== "typeyourown");

    return (
      <div className="space-y-1.5" role="group" aria-label={q.question}>
        <div className="text-[11px] text-violet-300/60 px-2.5 mb-1">Select all that apply</div>
        {visibleOptions.map(({ option, origIdx }, displayIdx) => {
          const isSelected = checked.has(origIdx);
          const inputId = `${groupName}-opt-${origIdx}`;
          return (
            <label key={origIdx} htmlFor={inputId} className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm cursor-pointer transition-all",
              isSelected
                ? "border border-violet-500/40 bg-violet-500/15 text-violet-100"
                : "border border-transparent hover:border-violet-500/20 hover:bg-violet-500/[0.07] text-foreground/70 hover:text-foreground/90",
            )}>
              <input type="checkbox" id={inputId} checked={isSelected}
                onChange={() => handleCheckboxToggle(qIdx, origIdx)} className="sr-only" />
              <span className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded border transition-all",
                isSelected ? "border-violet-400 bg-violet-500" : "border-violet-500/30 bg-transparent",
              )} aria-hidden="true">
                {isSelected && <Check className="size-2.5 text-white" strokeWidth={3} />}
              </span>
              <span className="flex items-center gap-1.5">
                <span className={cn(
                  "flex size-4 items-center justify-center rounded text-[10px] font-medium shrink-0",
                  isSelected ? "bg-violet-500/30 text-violet-200" : "bg-violet-500/15 text-violet-300/70",
                )} aria-hidden="true">{String.fromCharCode(65 + displayIdx)}</span>
                <span className="text-left leading-snug">{option}</span>
              </span>
            </label>
          );
        })}

        {renderWriteYourOwn(qIdx, groupName, isCustomChecked, "checkbox")}

        {isCustomChecked && renderCustomInput(qIdx, q.question)}
      </div>
    );
  };

  const renderRankedQuestion = (q: MultipleChoiceQuestion, qIdx: number) => {
    const visibleOptions = q.options
      .map((option, origIdx) => ({ option, origIdx }))
      .filter(({ option }) => option.toLowerCase().replace(/[^a-z]/g, "") !== "typeyourown");

    // Ensure order is initialized
    ensureRankedOrder(qIdx, visibleOptions.length);
    const order = rankedOrders.get(qIdx) ?? visibleOptions.map((_, i) => i);

    return (
      <div className="space-y-1" aria-label={q.question}>
        <div className="text-[11px] text-violet-300/60 px-2.5 mb-1">Drag or use arrows to rank by preference (top = most preferred)</div>
        {order.map((optIdx, rank) => {
          const item = visibleOptions[optIdx];
          if (!item) return null;
          const isDragging = dragIdx === rank;

          return (
            <div
              key={optIdx}
              draggable
              onDragStart={(e) => {
                setDragIdx(rank);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx !== null && dragIdx !== rank) {
                  handleRankedMove(qIdx, dragIdx, rank);
                }
                setDragIdx(null);
              }}
              onDragEnd={() => setDragIdx(null)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-all border",
                isDragging
                  ? "border-violet-400/60 bg-violet-500/20 opacity-50"
                  : "border-violet-500/20 bg-violet-500/[0.05] hover:bg-violet-500/[0.1]",
              )}
            >
              <GripVertical className="size-3.5 text-violet-400/50 cursor-grab shrink-0" />
              <span className={cn(
                "flex size-5 items-center justify-center rounded-full text-[11px] font-semibold shrink-0",
                rank === 0 ? "bg-violet-500/30 text-violet-200" : "bg-violet-500/15 text-violet-300/70",
              )}>
                {rank + 1}
              </span>
              <span className="text-left leading-snug flex-1 text-foreground/80">{item.option}</span>
              <div className="flex flex-col gap-0.5 shrink-0">
                <button
                  type="button"
                  disabled={rank === 0}
                  onClick={() => handleRankedMove(qIdx, rank, rank - 1)}
                  className={cn(
                    "p-0.5 rounded transition-colors",
                    rank === 0 ? "text-violet-500/20 cursor-not-allowed" : "text-violet-400/60 hover:text-violet-300 hover:bg-violet-500/20",
                  )}
                  aria-label={`Move ${item.option} up`}
                >
                  <ArrowUp className="size-3" />
                </button>
                <button
                  type="button"
                  disabled={rank === order.length - 1}
                  onClick={() => handleRankedMove(qIdx, rank, rank + 1)}
                  className={cn(
                    "p-0.5 rounded transition-colors",
                    rank === order.length - 1 ? "text-violet-500/20 cursor-not-allowed" : "text-violet-400/60 hover:text-violet-300 hover:bg-violet-500/20",
                  )}
                  aria-label={`Move ${item.option} down`}
                >
                  <ArrowDown className="size-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderWriteYourOwn = (qIdx: number, groupName: string, isActive: boolean, inputType: "radio" | "checkbox") => (
    <label
      htmlFor={`${groupName}-write`}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm cursor-pointer transition-all",
        isActive
          ? "border border-violet-500/40 bg-violet-500/15 text-violet-100"
          : "border border-dashed border-violet-500/20 hover:border-violet-400/30 hover:bg-violet-500/[0.07] text-violet-300/80 hover:text-violet-200",
      )}
    >
      <input
        type={inputType}
        id={`${groupName}-write`}
        name={inputType === "radio" ? groupName : undefined}
        value="__write_your_own__"
        checked={isActive}
        onChange={() => {
          const q = questions[qIdx];
          if (!q) return;
          if (inputType === "checkbox") {
            handleCheckboxToggle(qIdx, q.options.length);
          } else {
            handleRadioSelect(qIdx, q.options.length);
          }
        }}
        className="sr-only"
      />
      <span className={cn(
        "flex size-4 shrink-0 items-center justify-center border transition-all",
        inputType === "checkbox" ? "rounded" : "rounded-full",
        isActive ? "border-violet-400 bg-violet-500" : "border-violet-500/30 bg-transparent",
      )} aria-hidden="true">
        {isActive && <Check className="size-2.5 text-white" strokeWidth={3} />}
      </span>
      <PenLine className="size-3 shrink-0 opacity-70" aria-hidden="true" />
      <span className="leading-snug">Write your own…</span>
    </label>
  );

  const renderCustomInput = (qIdx: number, questionText: string) => (
    <div className="ml-9 mt-1">
      <input
        type="text"
        autoFocus
        value={customTexts.get(qIdx) ?? ""}
        onChange={(e) => handleCustomText(qIdx, e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (!isLastStep && currentQuestionAnswered) {
            handleNext();
          } else if (isLastStep && allAnswered) {
            handleSubmit();
          }
        }}
        placeholder="Type your answer…"
        aria-label={`Custom answer for: ${questionText}`}
        className={cn(
          "w-full rounded-md border border-violet-500/25 bg-violet-500/[0.05] px-2.5 py-1.5 text-sm text-foreground/90",
          "placeholder:text-violet-300/40 focus:border-violet-400/50 focus:outline-none focus:ring-1 focus:ring-violet-400/30",
        )}
      />
    </div>
  );

  const renderQuestion = (q: MultipleChoiceQuestion, qIdx: number) => {
    const type = getQuestionType(q);

    return (
      <fieldset key={qIdx} className="px-3 py-3 border-0">
        <legend className="text-sm font-medium leading-relaxed text-foreground/90 whitespace-pre-wrap mb-2.5 w-full float-left">
          {questions.length > 1 && (
            <span className="inline-flex items-center justify-center size-5 rounded-full bg-violet-500/20 text-[11px] font-semibold text-violet-300 mr-1.5 align-text-bottom">
              {qIdx + 1}
            </span>
          )}
          {q.question}
        </legend>

        <div className="clear-both">
          {type === "checkbox" && renderCheckboxQuestion(q, qIdx)}
          {type === "ranked" && renderRankedQuestion(q, qIdx)}
          {type === "radio" && renderRadioQuestion(q, qIdx)}
        </div>
      </fieldset>
    );
  };

  return (
    <div className={cn("overflow-hidden rounded-lg border border-violet-500/30 bg-gradient-to-b from-violet-500/[0.08] to-violet-500/[0.03] shadow-sm shadow-violet-500/5", className)}>
      <div className="flex items-center gap-2 border-b border-violet-500/15 px-3 py-2">
        <div className="flex size-6 items-center justify-center rounded-full bg-violet-500/15">
          <MessageCircleQuestion className="size-3.5 text-violet-400" />
        </div>
        <span className="text-xs font-medium text-violet-300">Question {currentStep + 1} of {questions.length}</span>
      </div>

      <div className="px-3 pt-2.5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-violet-500/15">
          <div
            className="h-full rounded-full bg-violet-500/60 transition-all"
            style={{ width: `${((currentStep + 1) / Math.max(questions.length, 1)) * 100}%` }}
          />
        </div>
      </div>

      {questions.length > 0 && renderQuestion(questions[currentStep]!, currentStep)}

      <div className="flex items-center gap-2 border-t border-violet-500/15 px-3 py-2.5">
        <Button
          size="sm"
          variant="outline"
          onClick={handleBack}
          disabled={currentStep === 0 || isSubmitting}
          className="gap-1.5"
        >
          <ArrowLeft className="size-3.5" />
          Back
        </Button>

        {!isLastStep ? (
          <Button
            size="sm"
            onClick={handleNext}
            disabled={!currentQuestionAnswered || isSubmitting}
            className={cn(
              "ml-auto gap-1.5",
              currentQuestionAnswered && !isSubmitting
                ? "bg-violet-600 hover:bg-violet-500 text-white shadow-sm shadow-violet-500/20"
                : "bg-violet-500/10 text-violet-300/50 cursor-not-allowed",
            )}
          >
            Next
            <ArrowRight className="size-3.5" />
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!allAnswered || isSubmitting}
            className={cn(
              "ml-auto gap-2",
              allAnswered && !isSubmitting
                ? "bg-violet-600 hover:bg-violet-500 text-white shadow-sm shadow-violet-500/20"
                : "bg-violet-500/10 text-violet-300/50 cursor-not-allowed",
            )}
          >
            <Send className="size-3.5" />
            {isSubmitting ? "Submitting…" : "Submit Answers"}
          </Button>
        )}
      </div>
    </div>
  );
}
