import * as React from "react";
import { MessageCircleQuestion, Check } from "lucide-react";
import {
  ToolCardShell,
  ToolCardHeader,
  ToolCardTitle,
  ToolCardActions,
  StatusPill,
} from "@/components/ui/tool-card";
import { parsePendingQuestions } from "@/lib/ask-user-questions";
import { parseAnswerResult } from "@/lib/ask-user-answer-parser";

export interface AskUserQuestionCardProps {
  toolInput: unknown;
  resultText: string | null;
  isStreaming: boolean;
}

export function AskUserQuestionCard({
  toolInput,
  resultText,
  isStreaming,
}: AskUserQuestionCardProps) {
  const inputArgs =
    toolInput && typeof toolInput === "object"
      ? (toolInput as Record<string, unknown>)
      : undefined;

  const questions = parsePendingQuestions(inputArgs);
  const answers = parseAnswerResult(resultText, questions);
  const isAnswered = answers !== null && answers.length > 0;
  const questionCount = questions.length;

  // While waiting for an answer, hide the tool card entirely —
  // the interactive stepper in the composer area handles the UX.
  if (!isAnswered) return null;

  // After answered: show a compact Q&A summary
  return (
    <ToolCardShell>
      <ToolCardHeader className="py-2">
        <ToolCardTitle
          icon={
            <div className="flex size-5 items-center justify-center rounded-full bg-violet-500/15">
              <MessageCircleQuestion className="size-3 text-violet-400" />
            </div>
          }
        >
          <span className="text-sm font-medium text-violet-300">
            {questionCount > 1 ? `${questionCount} Questions` : "Question"}
          </span>
        </ToolCardTitle>
        <ToolCardActions>
          <StatusPill variant="success">
            <Check className="size-3" />
            Answered
          </StatusPill>
        </ToolCardActions>
      </ToolCardHeader>

      <div className="space-y-0 divide-y divide-zinc-800/60">
        {answers.map((qa, i) => (
          <div key={i} className="px-4 py-2.5">
            <div className="text-xs font-medium text-zinc-400 mb-1">
              {questionCount > 1 && (
                <span className="inline-flex items-center justify-center size-4 rounded-full bg-violet-500/20 text-[10px] font-semibold text-violet-300 mr-1 align-text-bottom">
                  {i + 1}
                </span>
              )}
              {qa.question}
            </div>
            <div className="flex items-center gap-1.5 text-sm text-zinc-200">
              <Check className="size-3 text-green-400 shrink-0" />
              <span>{qa.answer}</span>
            </div>
          </div>
        ))}
      </div>
    </ToolCardShell>
  );
}
