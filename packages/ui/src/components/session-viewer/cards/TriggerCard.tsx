/**
 * TriggerCard — Renders conversation trigger-injected messages as distinct cards.
 * Supports ask_user_question, plan_review, session_complete, session_error, escalate.
 */

import * as React from "react";
import { ChevronDown, ChevronRight, Send, AlertCircle, CheckCircle2, Clock, Zap, XCircle } from "lucide-react";
import {
  ToolCardShell,
  ToolCardHeader,
  ToolCardTitle,
  ToolCardActions,
  ToolCardSection,
} from "@/components/ui/tool-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { parseTriggerBody } from "./trigger-parsers";
import type { ParsedTriggerQuestion } from "./trigger-parsers";
import { MultipleChoiceQuestions, type MultipleChoiceAnswers } from "@/components/ai-elements/multiple-choice";
import { formatAnswersForAgent } from "@/lib/ask-user-questions";
export { parseTriggerBody } from "./trigger-parsers";
export type { ParsedTrigger } from "./trigger-parsers";

export interface TriggerCardProps {
  triggerId: string;
  body: string;
  onRespond?: (triggerId: string, response: string, action?: string) => boolean | void;
  isResponding?: boolean;
}

// ── Ask User Question Card ──────────────────────────────────────────────────

function AskUserQuestionCard({
  triggerId,
  childName,
  question,
  options,
  questions,
  onRespond,
  isResponding,
}: {
  triggerId: string;
  childName?: string;
  question?: string;
  options?: string[];
  questions?: ParsedTriggerQuestion[];
  onRespond?: (triggerId: string, response: string) => boolean | void;
  isResponding?: boolean;
}) {
  const [selectedOption, setSelectedOption] = React.useState<string>("");
  const [freeText, setFreeText] = React.useState<string>("");
  const [submitted, setSubmitted] = React.useState(false);
  const hasOptions = options && options.length > 0;

  // Use rich multi-question UI when structured questions are available
  const hasStructuredQuestions = questions && questions.length > 0;

  const handleMultiChoiceSubmit = React.useCallback(
    (answers: MultipleChoiceAnswers) => {
      if (submitted) return;
      const text = formatAnswersForAgent(answers);
      const result = onRespond?.(triggerId, text);
      // Only mark as submitted if the response was actually sent.
      // onRespond returns false when the socket is disconnected.
      if (result !== false) {
        setSubmitted(true);
      }
    },
    [triggerId, onRespond, submitted],
  );

  return (
    <ToolCardShell>
      <ToolCardHeader className="py-2.5">
        <ToolCardTitle
          icon={<Zap className="size-3.5 shrink-0 text-blue-400" />}
        >
          <span className="text-sm font-medium text-zinc-300">
            Question from Child {childName ? `"${childName}"` : ""}
          </span>
        </ToolCardTitle>
      </ToolCardHeader>

      {/* Rich multi-question UI (radio / checkbox / ranked stepper) */}
      {hasStructuredQuestions && (
        <ToolCardSection>
          {submitted ? (
            <p className="text-sm text-zinc-400 italic">Response submitted.</p>
          ) : (
            <MultipleChoiceQuestions
              questions={questions}
              promptKey={triggerId}
              onSubmit={handleMultiChoiceSubmit}
            />
          )}
        </ToolCardSection>
      )}

      {/* Legacy single-question UI: shown only when no structured questions */}
      {!hasStructuredQuestions && (
        <>
          {question && (
            <ToolCardSection>
              <p className="text-sm text-zinc-200">{question}</p>
            </ToolCardSection>
          )}

          {hasOptions && (
            <ToolCardSection>
              <div className="space-y-2">
                {options.map((option, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setSelectedOption(option);
                      onRespond?.(triggerId, option);
                    }}
                    disabled={isResponding}
                    className={cn(
                      "w-full text-left px-3 py-2 rounded-md border text-sm transition-colors",
                      selectedOption === option
                        ? "border-blue-500 bg-blue-500/20 text-blue-300"
                        : "border-zinc-700 bg-zinc-800/40 text-zinc-300 hover:bg-zinc-800/60 hover:border-zinc-600",
                      isResponding && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </ToolCardSection>
          )}

          {/* Free-text input for open-ended questions (no options) */}
          {!hasOptions && (
            <ToolCardSection>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={freeText}
                  onChange={(e) => setFreeText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && freeText.trim()) {
                      onRespond?.(triggerId, freeText.trim());
                    }
                  }}
                  disabled={isResponding}
                  placeholder="Type your response…"
                  className={cn(
                    "flex-1 px-3 py-2 rounded-md border text-sm bg-zinc-800/40 text-zinc-200",
                    "border-zinc-700 placeholder:text-zinc-500 focus:outline-none focus:border-blue-500",
                    isResponding && "opacity-50 cursor-not-allowed"
                  )}
                />
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => {
                    if (freeText.trim()) onRespond?.(triggerId, freeText.trim());
                  }}
                  disabled={isResponding || !freeText.trim()}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  <Send className="size-3.5" />
                </Button>
              </div>
            </ToolCardSection>
          )}
        </>
      )}
    </ToolCardShell>
  );
}

// ── Plan Review Card ──────────────────────────────────────────────────────

function PlanReviewCard({
  triggerId,
  childName,
  planTitle,
  planSteps,
  onRespond,
  isResponding,
}: {
  triggerId: string;
  childName?: string;
  planTitle?: string;
  planSteps?: Array<{ title: string; description?: string }>;
  onRespond?: (triggerId: string, response: string, action: string) => boolean | void;
  isResponding?: boolean;
}) {
  return (
    <ToolCardShell>
      <ToolCardHeader className="py-2.5">
        <ToolCardTitle
          icon={<Clock className="size-3.5 shrink-0 text-amber-400" />}
        >
          <span className="text-sm font-medium text-zinc-300">
            Plan Review from {childName ? `"${childName}"` : "Child"}
          </span>
        </ToolCardTitle>
      </ToolCardHeader>

      {planTitle && (
        <ToolCardSection>
          <h3 className="text-sm font-semibold text-zinc-100 mb-2">{planTitle}</h3>
          {planSteps && planSteps.length > 0 && (
            <ol className="space-y-2 text-sm text-zinc-300">
              {planSteps.map((step, i) => (
                <li key={i} className="list-decimal list-inside">
                  <span className="font-medium">{step.title}</span>
                  {step.description && (
                    <div className="ml-5 mt-1 text-zinc-400 text-xs">
                      {step.description}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </ToolCardSection>
      )}

      <div className="flex flex-wrap gap-2 px-4 py-3 border-t border-zinc-800 bg-zinc-900/50">
        <Button
          size="sm"
          variant="default"
          onClick={() => onRespond?.(triggerId, "Begin", "approve")}
          disabled={isResponding}
          className="bg-emerald-600 hover:bg-emerald-700 text-xs"
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRespond?.(triggerId, "Cancel", "cancel")}
          disabled={isResponding}
          className="text-xs"
        >
          Reject
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const feedback = prompt("Enter feedback for the plan:");
            if (feedback) {
              onRespond?.(triggerId, feedback, "edit");
            }
          }}
          disabled={isResponding}
          className="text-xs"
        >
          Edit
        </Button>
      </div>
    </ToolCardShell>
  );
}

// ── Session Complete Card ──────────────────────────────────────────────────

function SessionCompleteCard({
  childName,
  message,
  exitReason,
  fullOutputPath,
}: {
  childName?: string;
  message?: string;
  exitReason?: "completed" | "killed" | "error";
  fullOutputPath?: string;
}) {
  const reason = exitReason ?? "completed";
  const icon = reason === "killed"
    ? <XCircle className="size-3.5 shrink-0 text-amber-400" />
    : reason === "error"
    ? <AlertCircle className="size-3.5 shrink-0 text-red-400" />
    : <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />;
  const verb = reason === "killed" ? "Killed"
    : reason === "error" ? "Errored"
    : "Completed";

  return (
    <ToolCardShell>
      <ToolCardHeader className="py-2.5">
        <ToolCardTitle icon={icon}>
          <span className="text-sm font-medium text-zinc-300">
            {verb}: {childName ? `"${childName}"` : "Child"}
          </span>
        </ToolCardTitle>
      </ToolCardHeader>

      {message && (
        <ToolCardSection>
          <p className="text-sm text-zinc-200 whitespace-pre-wrap">{message}</p>
        </ToolCardSection>
      )}

      {fullOutputPath && (
        <ToolCardSection>
          <p className="text-xs text-zinc-400">
            📄 Full output saved to:{" "}
            <span className="font-mono text-zinc-300 break-all">{fullOutputPath}</span>
          </p>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

// ── Session Error Card ──────────────────────────────────────────────────────

function SessionErrorCard({
  triggerId,
  childName,
  message,
}: {
  triggerId: string;
  childName?: string;
  message?: string;
}) {
  return (
    <ToolCardShell>
      <ToolCardHeader className="py-2.5">
        <ToolCardTitle
          icon={<AlertCircle className="size-3.5 shrink-0 text-red-400" />}
        >
          <span className="text-sm font-medium text-zinc-300">
            Error from {childName ? `"${childName}"` : "Child"}
          </span>
        </ToolCardTitle>
      </ToolCardHeader>

      {message && (
        <ToolCardSection>
          <p className="text-sm text-red-300 whitespace-pre-wrap">{message}</p>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

// ── Escalate Trigger Card ──────────────────────────────────────────────────

function EscalateCard({
  childName,
  reason,
}: {
  childName?: string;
  reason?: string;
}) {
  return (
    <ToolCardShell>
      <ToolCardHeader className="py-2.5 border-yellow-600/30 bg-yellow-950/20">
        <ToolCardTitle
          icon={<AlertCircle className="size-3.5 shrink-0 text-yellow-400" />}
        >
          <span className="text-sm font-medium text-yellow-300">
            Escalated from {childName ? `"${childName}"` : "Child"}
          </span>
        </ToolCardTitle>
      </ToolCardHeader>

      {reason && (
        <ToolCardSection>
          <p className="text-sm text-yellow-200 whitespace-pre-wrap">{reason}</p>
        </ToolCardSection>
      )}

      <div className="border-t border-yellow-600/20 bg-yellow-950/10 px-4 py-2 text-xs text-yellow-300">
        Requires human attention. Escalated from parent agent to viewer.
      </div>
    </ToolCardShell>
  );
}

// ── Main TriggerCard Component ──────────────────────────────────────────────

export function TriggerCard({
  triggerId,
  body,
  onRespond,
  isResponding,
}: TriggerCardProps) {
  const parsed = parseTriggerBody(body);

  switch (parsed.type) {
    case "ask_user_question":
      return (
        <AskUserQuestionCard
          triggerId={triggerId}
          childName={parsed.childName}
          question={parsed.question}
          options={parsed.options}
          questions={parsed.questions}
          onRespond={onRespond}
          isResponding={isResponding}
        />
      );
    case "plan_review":
      return (
        <PlanReviewCard
          triggerId={triggerId}
          childName={parsed.childName}
          planTitle={parsed.planTitle}
          planSteps={parsed.planSteps}
          onRespond={onRespond}
          isResponding={isResponding}
        />
      );
    case "session_complete":
      return (
        <SessionCompleteCard
          childName={parsed.childName}
          message={parsed.message}
          exitReason={parsed.exitReason}
          fullOutputPath={parsed.fullOutputPath}
        />
      );
    case "session_error":
      return (
        <SessionErrorCard
          triggerId={triggerId}
          childName={parsed.childName}
          message={parsed.message}
        />
      );
    case "escalate":
      return (
        <EscalateCard
          childName={parsed.childName}
          reason={parsed.reason}
        />
      );
    default:
      // Unknown trigger type — render as plain text fallback so
      // the message is still visible in the UI
      return (
        <div className="rounded-lg border p-4 bg-muted/30">
          <p className="text-xs text-muted-foreground mb-2">Unknown trigger type: {parsed.type ?? "unknown"}</p>
          <pre className="text-sm whitespace-pre-wrap break-words">{body}</pre>
        </div>
      );
  }
}
