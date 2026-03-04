import * as React from "react";
import { cn } from "@/lib/utils";
import { MessageCircleQuestion, PenLine, Send, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface MultipleChoiceQuestion {
  question: string;
  options: string[];
}

export interface MultipleChoiceQuestionsProps {
  questions: MultipleChoiceQuestion[];
  onSubmit: (answers: Record<string, string>) => void;
  className?: string;
}

/**
 * A multiple-choice question panel that replaces the text input when the agent
 * asks the user one or more questions. Each question shows radio-style options
 * plus a "Write your own…" free-form option.
 */
export function MultipleChoiceQuestions({
  questions,
  onSubmit,
  className,
}: MultipleChoiceQuestionsProps) {
  // Track selected option index per question (null = none selected)
  const [selections, setSelections] = React.useState<Map<number, number>>(new Map());
  // Track custom text per question (used when "Write your own…" is selected)
  const [customTexts, setCustomTexts] = React.useState<Map<number, string>>(new Map());

  // Reset state when questions change (e.g. new AskUserQuestion)
  const questionsKey = React.useMemo(() => questions.map(q => q.question).join("\0"), [questions]);
  React.useEffect(() => {
    setSelections(new Map());
    setCustomTexts(new Map());
  }, [questionsKey]);

  // "Write your own…" is always the last option index (= options.length)
  const isWriteYourOwn = (qIdx: number) => selections.get(qIdx) === questions[qIdx].options.length;

  const allAnswered = questions.every((q, idx) => {
    const sel = selections.get(idx);
    if (sel === undefined || sel === null) return false;
    // If "Write your own…" is selected, require non-empty text
    if (sel === q.options.length) return (customTexts.get(idx) ?? "").trim().length > 0;
    return true;
  });

  const handleSelect = (qIdx: number, optIdx: number) => {
    setSelections((prev) => {
      const next = new Map(prev);
      next.set(qIdx, optIdx);
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

  const handleSubmit = () => {
    if (!allAnswered) return;
    const answers: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const sel = selections.get(i)!;
      answers[q.question] = sel === q.options.length
        ? (customTexts.get(i) ?? "").trim()
        : q.options[sel];
    }
    onSubmit(answers);
  };

  return (
    <div className={cn("overflow-hidden rounded-lg border border-violet-500/30 bg-gradient-to-b from-violet-500/[0.08] to-violet-500/[0.03] shadow-sm shadow-violet-500/5", className)}>
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-violet-500/15 px-3 py-2">
        <div className="flex size-6 items-center justify-center rounded-full bg-violet-500/15">
          <MessageCircleQuestion className="size-3.5 text-violet-400" />
        </div>
        <span className="text-xs font-medium text-violet-300">
          {questions.length === 1 ? "Waiting for your answer" : `Answer ${questions.length} questions`}
        </span>
      </div>

      {/* Questions */}
      <div className="divide-y divide-violet-500/10">
        {questions.map((q, qIdx) => {
          const selected = selections.get(qIdx);
          const writeYourOwnIdx = q.options.length;
          const isCustom = selected === writeYourOwnIdx;

          return (
            <div key={qIdx} className="px-3 py-3">
              {/* Question text */}
              <p className="text-sm font-medium leading-relaxed text-foreground/90 whitespace-pre-wrap mb-2.5">
                {questions.length > 1 && (
                  <span className="inline-flex items-center justify-center size-5 rounded-full bg-violet-500/20 text-[11px] font-semibold text-violet-300 mr-1.5 align-text-bottom">
                    {qIdx + 1}
                  </span>
                )}
                {q.question}
              </p>

              {/* Options as radio buttons */}
              <div className="space-y-1.5">
                {q.options.map((option, optIdx) => {
                  // Skip "Type your own" entries from the agent — we provide our own
                  const isAgentTypeYourOwn = option.toLowerCase().replace(/[^a-z]/g, "") === "typeyourown";
                  if (isAgentTypeYourOwn) return null;

                  const isSelected = selected === optIdx;

                  return (
                    <label
                      key={optIdx}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm cursor-pointer transition-all",
                        isSelected
                          ? "border border-violet-500/40 bg-violet-500/15 text-violet-100"
                          : "border border-transparent hover:border-violet-500/20 hover:bg-violet-500/[0.07] text-foreground/70 hover:text-foreground/90",
                      )}
                      onClick={() => handleSelect(qIdx, optIdx)}
                    >
                      {/* Radio circle */}
                      <span className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border transition-all",
                        isSelected
                          ? "border-violet-400 bg-violet-500"
                          : "border-violet-500/30 bg-transparent",
                      )}>
                        {isSelected && <Check className="size-2.5 text-white" strokeWidth={3} />}
                      </span>
                      {/* Option letter + text */}
                      <span className="flex items-center gap-1.5">
                        <span className={cn(
                          "flex size-4 items-center justify-center rounded text-[10px] font-medium shrink-0",
                          isSelected ? "bg-violet-500/30 text-violet-200" : "bg-violet-500/15 text-violet-300/70",
                        )}>
                          {String.fromCharCode(65 + optIdx)}
                        </span>
                        <span className="text-left leading-snug">{option}</span>
                      </span>
                    </label>
                  );
                })}

                {/* "Write your own…" option */}
                <label
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm cursor-pointer transition-all",
                    isCustom
                      ? "border border-violet-500/40 bg-violet-500/15 text-violet-100"
                      : "border border-dashed border-violet-500/20 hover:border-violet-400/30 hover:bg-violet-500/[0.07] text-violet-300/80 hover:text-violet-200",
                  )}
                  onClick={() => handleSelect(qIdx, writeYourOwnIdx)}
                >
                  <span className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border transition-all",
                    isCustom
                      ? "border-violet-400 bg-violet-500"
                      : "border-violet-500/30 bg-transparent",
                  )}>
                    {isCustom && <Check className="size-2.5 text-white" strokeWidth={3} />}
                  </span>
                  <PenLine className="size-3 shrink-0 opacity-70" />
                  <span className="leading-snug">Write your own…</span>
                </label>

                {/* Custom text input (shown when "Write your own…" is selected) */}
                {isCustom && (
                  <div className="ml-9 mt-1">
                    <input
                      type="text"
                      autoFocus
                      value={customTexts.get(qIdx) ?? ""}
                      onChange={(e) => handleCustomText(qIdx, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && allAnswered) {
                          e.preventDefault();
                          handleSubmit();
                        }
                      }}
                      placeholder="Type your answer…"
                      className={cn(
                        "w-full rounded-md border border-violet-500/25 bg-violet-500/[0.05] px-2.5 py-1.5 text-sm text-foreground/90",
                        "placeholder:text-violet-300/40 focus:border-violet-400/50 focus:outline-none focus:ring-1 focus:ring-violet-400/30",
                      )}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Submit button */}
      <div className="border-t border-violet-500/15 px-3 py-2.5">
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!allAnswered}
          className={cn(
            "w-full gap-2 transition-all",
            allAnswered
              ? "bg-violet-600 hover:bg-violet-500 text-white shadow-sm shadow-violet-500/20"
              : "bg-violet-500/10 text-violet-300/50 cursor-not-allowed",
          )}
        >
          <Send className="size-3.5" />
          Submit {questions.length === 1 ? "Answer" : "Answers"}
        </Button>
      </div>
    </div>
  );
}
