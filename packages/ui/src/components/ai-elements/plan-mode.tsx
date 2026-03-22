import * as React from "react";
import { cn } from "@/lib/utils";
import {
  ClipboardList,
  Eraser,
  Play,
  PenLine,
  X,
  Send,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export interface PlanModeStep {
  title: string;
  description?: string;
}

export interface PlanModeData {
  toolCallId: string;
  title: string;
  description: string | null;
  steps: PlanModeStep[];
}

export type PlanModeAction = "execute" | "execute_keep_context" | "edit" | "cancel";

export interface PlanModeAnswer {
  action: PlanModeAction;
  editSuggestion?: string;
}

export interface PlanModePanelProps {
  plan: PlanModeData;
  /** Stable identity for this prompt (e.g. toolCallId). Used to reset state on new prompt. */
  promptKey?: string;
  onSubmit: (answer: PlanModeAnswer) => void | Promise<boolean | void>;
  className?: string;
}

/**
 * Plan review panel that replaces the text input when the agent submits a plan
 * for user approval. Scrollable on mobile so it never blocks the full viewport.
 */
export function PlanModePanel({
  plan,
  promptKey,
  onSubmit,
  className,
}: PlanModePanelProps) {
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [showEditInput, setShowEditInput] = React.useState(false);
  const [editText, setEditText] = React.useState("");
  // Auto-collapse steps when there are many
  const [stepsExpanded, setStepsExpanded] = React.useState(plan.steps.length <= 5);
  const submitTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset state when the prompt identity changes
  React.useEffect(() => {
    setIsSubmitting(false);
    setShowEditInput(false);
    setEditText("");
    setStepsExpanded(plan.steps.length <= 5);
    if (submitTimeoutRef.current !== null) {
      clearTimeout(submitTimeoutRef.current);
      submitTimeoutRef.current = null;
    }
  }, [promptKey, plan.steps.length]);

  const handleAction = (action: PlanModeAction, editSuggestion?: string) => {
    if (isSubmitting) return;
    setIsSubmitting(true);

    // Safety-valve timeout: if onSubmit never resolves AND the promptKey never
    // changes, unlock after 30s so the UI isn't permanently stuck.  The
    // promptKey-change effect above is the primary unlock path.
    if (submitTimeoutRef.current !== null) clearTimeout(submitTimeoutRef.current);
    submitTimeoutRef.current = setTimeout(() => {
      submitTimeoutRef.current = null;
      setIsSubmitting(false);
    }, 30_000);

    const answer: PlanModeAnswer = { action, editSuggestion };
    Promise.resolve(onSubmit(answer))
      .then((result) => {
        if (result === false) {
          if (submitTimeoutRef.current !== null) {
            clearTimeout(submitTimeoutRef.current);
            submitTimeoutRef.current = null;
          }
          setIsSubmitting(false);
        }
      })
      .catch(() => {
        if (submitTimeoutRef.current !== null) {
          clearTimeout(submitTimeoutRef.current);
          submitTimeoutRef.current = null;
        }
        setIsSubmitting(false);
      });
  };

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-blue-500/30 bg-gradient-to-b from-blue-500/[0.08] to-blue-500/[0.03] shadow-sm shadow-blue-500/5",
        // Cap height so it never takes over the viewport on mobile
        "max-h-[50vh] sm:max-h-[60vh]",
        className,
      )}
    >
      {/* Header — always visible */}
      <div className="flex items-center gap-2 border-b border-blue-500/15 px-3 py-2 shrink-0">
        <div className="flex size-6 items-center justify-center rounded-full bg-blue-500/15">
          <ClipboardList className="size-3.5 text-blue-400" />
        </div>
        <span className="text-xs font-medium text-blue-300">Plan Review</span>
      </div>

      {/* Scrollable plan content */}
      <div className="flex-1 overflow-y-auto min-h-0 overscroll-contain">
        <div className="px-3 py-3 space-y-2.5">
          {/* Title */}
          <h3 className="text-sm font-semibold text-foreground/90 leading-snug">
            {plan.title}
          </h3>

          {/* Description */}
          {plan.description && (
            <p className="text-xs text-foreground/70 leading-relaxed whitespace-pre-wrap">
              {plan.description}
            </p>
          )}

          {/* Steps */}
          {plan.steps.length > 0 && (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setStepsExpanded((v) => !v)}
                className="flex items-center gap-1.5 text-[11px] font-medium text-blue-300/80 hover:text-blue-200 transition-colors cursor-pointer"
              >
                <ChevronDown
                  className={cn(
                    "size-3 transition-transform",
                    !stepsExpanded && "-rotate-90",
                  )}
                />
                {plan.steps.length} Step{plan.steps.length !== 1 ? "s" : ""}
              </button>

              {stepsExpanded && (
                <ol className="space-y-1.5 pl-1">
                  {plan.steps.map((step, i) => (
                    <li key={i} className="flex gap-2">
                      <span
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold mt-0.5",
                          "bg-blue-500/15 text-blue-300/70",
                        )}
                      >
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <span className="text-sm text-foreground/85 leading-snug">
                          {step.title}
                        </span>
                        {step.description && (
                          <p className="text-xs text-foreground/50 leading-relaxed mt-0.5">
                            {step.description}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Edit suggestion input (shown when "Suggest Edit" is clicked) */}
      {showEditInput && (
        <div className="px-3 pb-2.5 shrink-0">
          <div className="flex items-center gap-2">
            <input
              type="text"
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && editText.trim()) {
                  e.preventDefault();
                  handleAction("edit", editText.trim());
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setShowEditInput(false);
                  setEditText("");
                }
              }}
              placeholder="Describe your suggested changes…"
              aria-label="Suggest an edit to the plan"
              className={cn(
                "flex-1 rounded-md border border-blue-500/25 bg-blue-500/[0.05] px-2.5 py-1.5 text-sm text-foreground/90",
                "placeholder:text-blue-300/40 focus:border-blue-400/50 focus:outline-none focus:ring-1 focus:ring-blue-400/30",
              )}
            />
            <Button
              size="sm"
              onClick={() => {
                if (editText.trim()) handleAction("edit", editText.trim());
              }}
              disabled={!editText.trim() || isSubmitting}
              className={cn(
                "gap-1.5 shrink-0",
                editText.trim() && !isSubmitting
                  ? "bg-blue-600 hover:bg-blue-500 text-white shadow-sm shadow-blue-500/20"
                  : "bg-blue-500/10 text-blue-300/50 cursor-not-allowed",
              )}
            >
              <Send className="size-3" />
              Send
            </Button>
          </div>
        </div>
      )}

      {/* Action buttons — 2×2 grid on mobile, flex row on desktop */}
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:items-center gap-1.5 sm:gap-2 border-t border-blue-500/15 px-3 py-2.5 shrink-0">
        <Button
          size="sm"
          onClick={() => handleAction("execute")}
          disabled={isSubmitting}
          className={cn(
            "gap-1 sm:gap-1.5 text-xs sm:text-sm",
            !isSubmitting
              ? "bg-blue-600 hover:bg-blue-500 text-white shadow-sm shadow-blue-500/20"
              : "bg-blue-500/10 text-blue-300/50 cursor-not-allowed",
          )}
        >
          <Eraser className="size-3.5 shrink-0" />
          <span className="sm:hidden">New Context</span>
          <span className="hidden sm:inline">Clear Context & Begin</span>
        </Button>

        <Button
          size="sm"
          onClick={() => handleAction("execute_keep_context")}
          disabled={isSubmitting}
          className={cn(
            "gap-1 sm:gap-1.5 text-xs sm:text-sm",
            !isSubmitting
              ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm shadow-emerald-500/20"
              : "bg-emerald-500/10 text-emerald-300/50 cursor-not-allowed",
          )}
        >
          <Play className="size-3.5 shrink-0" />
          Begin
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setShowEditInput(true);
          }}
          disabled={isSubmitting || showEditInput}
          className="gap-1 sm:gap-1.5 text-xs sm:text-sm"
        >
          <PenLine className="size-3.5 shrink-0" />
          Suggest Edit
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={() => handleAction("cancel")}
          disabled={isSubmitting}
          className="gap-1 sm:gap-1.5 text-xs sm:text-sm sm:ml-auto text-red-400 hover:text-red-300 border-red-500/30 hover:border-red-500/50 hover:bg-red-500/10"
        >
          <X className="size-3.5 shrink-0" />
          Cancel
        </Button>
      </div>
    </div>
  );
}
