import * as React from "react";
import { ClipboardList, X, PenLine, Play, Eraser } from "lucide-react";
import {
  ToolCardShell,
  ToolCardHeader,
  ToolCardTitle,
  ToolCardActions,
  StatusPill,
} from "@/components/ui/tool-card";
import type { PlanModeStep } from "@/components/ai-elements/plan-mode";

type PlanModeAction = "execute" | "execute_keep_context" | "edit" | "cancel";

interface PlanModeDetails {
  title: string;
  description: string | null;
  steps: PlanModeStep[];
  action: PlanModeAction | null;
  editSuggestion: string | null;
  status?: "waiting" | "responded";
}

export interface PlanModeCardProps {
  toolInput: unknown;
  resultText: string | null;
  isStreaming: boolean;
}

function parsePlanModeDetails(toolInput: unknown): PlanModeDetails | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const input = toolInput as Record<string, unknown>;

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return null;

  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : null;

  const steps: PlanModeStep[] = Array.isArray(input.steps)
    ? (input.steps as unknown[])
        .filter(
          (s): s is Record<string, unknown> =>
            s !== null && typeof s === "object",
        )
        .map((s) => ({
          title:
            typeof s.title === "string" ? (s.title as string).trim() : "",
          description:
            typeof s.description === "string" &&
            (s.description as string).trim()
              ? (s.description as string).trim()
              : undefined,
        }))
        .filter((s) => s.title.length > 0)
    : [];

  return {
    title,
    description,
    steps,
    action: null,
    editSuggestion: null,
  };
}

function parseActionFromResult(
  resultText: string | null,
): { action: PlanModeAction; editSuggestion: string | null } | null {
  if (!resultText) return null;
  const text = resultText.trim();

  if (text.includes("Clear Context & Begin")) {
    return { action: "execute", editSuggestion: null };
  }
  if (text.includes("User chose: Begin")) {
    return { action: "execute_keep_context", editSuggestion: null };
  }
  if (text.includes("Suggest Edit")) {
    const match = /Suggestion:\s*(.+)$/s.exec(text);
    return {
      action: "edit",
      editSuggestion: match?.[1]?.trim() ?? null,
    };
  }
  if (text.includes("Cancel")) {
    return { action: "cancel", editSuggestion: null };
  }
  if (text.includes("cancelled") || text.includes("no response")) {
    return { action: "cancel", editSuggestion: null };
  }
  return null;
}

const ACTION_CONFIG: Record<
  PlanModeAction,
  {
    label: string;
    icon: React.ReactNode;
    variant: "success" | "info" | "error" | "neutral";
  }
> = {
  execute: {
    label: "Clear Context & Begin",
    icon: <Eraser className="size-3" />,
    variant: "success",
  },
  execute_keep_context: {
    label: "Begin",
    icon: <Play className="size-3" />,
    variant: "success",
  },
  edit: {
    label: "Edit Suggested",
    icon: <PenLine className="size-3" />,
    variant: "info",
  },
  cancel: {
    label: "Cancelled",
    icon: <X className="size-3" />,
    variant: "error",
  },
};

export function PlanModeCard({
  toolInput,
  resultText,
  isStreaming,
}: PlanModeCardProps) {
  const plan = parsePlanModeDetails(toolInput);
  const actionResult = parseActionFromResult(resultText);
  const isResponded = actionResult !== null;

  // While streaming/waiting for a response, hide the tool card —
  // the interactive panel in the composer area handles the UX.
  if (isStreaming && !isResponded) return null;

  // If the tool completed but we have no result text at all (still waiting), hide.
  if (!resultText && !isStreaming) return null;

  // If there's result text but we can't parse an action, show a fallback
  // (e.g. error messages like "A different plan_mode prompt is already pending.")
  if (resultText && !isResponded) {
    return (
      <ToolCardShell>
        <ToolCardHeader className="py-2">
          <ToolCardTitle
            icon={
              <div className="flex size-5 items-center justify-center rounded-full bg-blue-500/15">
                <ClipboardList className="size-3 text-blue-400" />
              </div>
            }
          >
            <span className="text-sm font-medium text-blue-300">
              Plan{plan ? `: ${plan.title}` : ""}
            </span>
          </ToolCardTitle>
          <ToolCardActions>
            <StatusPill variant="error">
              <X className="size-3" />
              Error
            </StatusPill>
          </ToolCardActions>
        </ToolCardHeader>
        <div className="px-4 py-2.5 text-sm text-zinc-300">
          {resultText}
        </div>
      </ToolCardShell>
    );
  }

  if (!plan) return null;

  const action = actionResult?.action ?? "cancel";
  const config = ACTION_CONFIG[action];

  return (
    <ToolCardShell>
      <ToolCardHeader className="py-2">
        <ToolCardTitle
          icon={
            <div className="flex size-5 items-center justify-center rounded-full bg-blue-500/15">
              <ClipboardList className="size-3 text-blue-400" />
            </div>
          }
        >
          <span className="text-sm font-medium text-blue-300">
            Plan: {plan.title}
          </span>
        </ToolCardTitle>
        <ToolCardActions>
          <StatusPill variant={config.variant}>
            {config.icon}
            {config.label}
          </StatusPill>
        </ToolCardActions>
      </ToolCardHeader>

      {/* Steps summary */}
      {plan.steps.length > 0 && (
        <div className="px-4 py-2 space-y-1 border-t border-zinc-800/60">
          {plan.steps.map((step, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="inline-flex items-center justify-center size-4 rounded-full bg-blue-500/15 text-[10px] font-semibold text-blue-300/70 shrink-0 mt-0.5">
                {i + 1}
              </span>
              <span className="text-zinc-400">{step.title}</span>
            </div>
          ))}
        </div>
      )}

      {/* Edit suggestion (if action was "edit") */}
      {action === "edit" && actionResult?.editSuggestion && (
        <div className="px-4 py-2 border-t border-zinc-800/60">
          <div className="text-xs text-zinc-500 mb-0.5">Edit suggestion:</div>
          <div className="text-sm text-zinc-200">
            {actionResult.editSuggestion}
          </div>
        </div>
      )}
    </ToolCardShell>
  );
}
