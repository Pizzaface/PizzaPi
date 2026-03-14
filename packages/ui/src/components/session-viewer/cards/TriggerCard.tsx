/**
 * TriggerCard — Renders conversation trigger-injected messages as distinct cards.
 * Supports ask_user_question, plan_review, session_complete, session_error, escalate.
 */

import * as React from "react";
import { ChevronDown, ChevronRight, Send, AlertCircle, CheckCircle2, Clock, Zap } from "lucide-react";
import {
  ToolCardShell,
  ToolCardHeader,
  ToolCardTitle,
  ToolCardActions,
  ToolCardSection,
} from "@/components/ui/tool-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface TriggerCardProps {
  triggerId: string;
  body: string;
  onRespond?: (triggerId: string, response: string, action?: string) => void;
  isResponding?: boolean;
}

/**
 * Parse and render trigger message body into structured components.
 * Detects trigger type from content patterns.
 */
function parseTriggerBody(body: string): {
  type: "ask_user_question" | "plan_review" | "session_complete" | "session_error" | "escalate" | "unknown";
  childName?: string;
  question?: string;
  options?: string[];
  planTitle?: string;
  planSteps?: Array<{ title: string; description?: string }>;
  message?: string;
  reason?: string;
} {
  // Detect trigger type from content patterns
  // ask_user_question: may or may not have Options line (open-ended questions omit it)
  if (body.includes('" asks:')) {
    return parsAskUserQuestion(body);
  }
  if (body.includes("submitted a plan for review")) {
    return parsePlanReview(body);
  }
  if (body.includes("completed:")) {
    return parseSessionComplete(body);
  }
  if (body.includes("encountered an error:")) {
    return parseSessionError(body);
  }
  if (body.includes("Trigger escalated")) {
    return parseEscalateTrigger(body);
  }
  
  return { type: "unknown" };
}

function parsAskUserQuestion(body: string): ReturnType<typeof parseTriggerBody> {
  const childMatch = body.match(/Child "([^"]+)" asks:/);
  const childName = childMatch?.[1];
  const questionMatch = body.match(/> (.+)/);
  const question = questionMatch?.[1];
  const optionsMatch = body.match(/Options: (.+)/);
  const optionsStr = optionsMatch?.[1];
  const options = optionsStr
    ? optionsStr
        .split(/  /)
        .map((opt) => opt.replace(/^\d+\. /, "").trim())
        .filter(Boolean)
    : [];

  return { type: "ask_user_question", childName, question, options };
}

function parsePlanReview(body: string): ReturnType<typeof parseTriggerBody> {
  const childMatch = body.match(/Child "([^"]+)" submitted/);
  const childName = childMatch?.[1];
  const titleMatch = body.match(/## (.+)/);
  const planTitle = titleMatch?.[1];

  // Parse steps (numbered lines)
  const steps: Array<{ title: string; description?: string }> = [];
  const stepRegex = /(\d+)\. (.+?)(?:\n   (.+?))?(?=\n\d+\.|$)/gs;
  let match;
  while ((match = stepRegex.exec(body))) {
    steps.push({
      title: match[2],
      description: match[3]?.trim(),
    });
  }

  return { type: "plan_review", childName, planTitle, planSteps: steps };
}

function parseSessionComplete(body: string): ReturnType<typeof parseTriggerBody> {
  const childMatch = body.match(/Child "([^"]+)" completed:/);
  const childName = childMatch?.[1];
  // Everything after "completed:" is the summary
  const summaryMatch = body.match(/completed:\n(.+?)(?=\n\nAcknowledge|$)/s);
  const message = summaryMatch?.[1]?.trim();

  return { type: "session_complete", childName, message };
}

function parseSessionError(body: string): ReturnType<typeof parseTriggerBody> {
  const childMatch = body.match(/Child "([^"]+)" encountered/);
  const childName = childMatch?.[1];
  const msgMatch = body.match(/error:\n(.+?)(?=\n\nRespond|$)/s);
  const message = msgMatch?.[1]?.trim();

  return { type: "session_error", childName, message };
}

function parseEscalateTrigger(body: string): ReturnType<typeof parseTriggerBody> {
  const childMatch = body.match(/from child "([^"]+)"/);
  const childName = childMatch?.[1];
  const reasonMatch = body.match(/escalated from child "[^"]+"[:\s]*\n(.+?)(?=\n\n|$)/s);
  const reason = reasonMatch?.[1]?.trim();

  return { type: "escalate", childName, reason };
}

// ── Ask User Question Card ──────────────────────────────────────────────────

function AskUserQuestionCard({
  triggerId,
  childName,
  question,
  options,
  onRespond,
  isResponding,
}: {
  triggerId: string;
  childName?: string;
  question?: string;
  options?: string[];
  onRespond?: (triggerId: string, response: string) => void;
  isResponding?: boolean;
}) {
  const [selectedOption, setSelectedOption] = React.useState<string>("");

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

      {question && (
        <ToolCardSection>
          <p className="text-sm text-zinc-200">{question}</p>
        </ToolCardSection>
      )}

      {options && options.length > 0 && (
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
  onRespond?: (triggerId: string, response: string, action: string) => void;
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
}: {
  childName?: string;
  message?: string;
}) {
  return (
    <ToolCardShell>
      <ToolCardHeader className="py-2.5">
        <ToolCardTitle
          icon={<CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" />}
        >
          <span className="text-sm font-medium text-zinc-300">
            Completed: {childName ? `"${childName}"` : "Child"}
          </span>
        </ToolCardTitle>
      </ToolCardHeader>

      {message && (
        <ToolCardSection>
          <p className="text-sm text-zinc-200 whitespace-pre-wrap">{message}</p>
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
      // Unknown trigger type — render as plain message
      return null;
  }
}
