"use client";

import type { ComponentProps, ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

// ── Status badge ──────────────────────────────────────────────────────────────

const statusLabels: Record<ToolState, string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolState, ReactNode> = {
  "approval-requested": <ClockIcon className="size-3 text-yellow-500" />,
  "approval-responded": <CheckCircleIcon className="size-3 text-blue-500" />,
  "input-available": <ClockIcon className="size-3 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-3" />,
  "output-available": <CheckCircleIcon className="size-3 text-green-500" />,
  "output-denied": <XCircleIcon className="size-3 text-orange-500" />,
  "output-error": <XCircleIcon className="size-3 text-red-500" />,
};

export const getStatusBadge = (state: ToolState) => (
  <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
    {statusIcons[state]}
    {statusLabels[state]}
  </span>
);

// ── Tool ──────────────────────────────────────────────────────────────────────

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group w-full rounded-md border border-border/80 bg-muted/30 overflow-hidden", className)}
    {...props}
  />
);

// ── ToolHeader ────────────────────────────────────────────────────────────────

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  state: ToolState;
};

export const ToolHeader = ({ className, toolName, state, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      "flex w-full items-center justify-between gap-4 px-2 py-1.5 text-left",
      className,
    )}
    {...props}
  >
    <div className="flex items-center gap-2">
      <WrenchIcon className="size-3.5 text-muted-foreground shrink-0" />
      <span className="text-xs font-semibold">{toolName}</span>
      {getStatusBadge(state)}
    </div>
    <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 shrink-0" />
  </CollapsibleTrigger>
);

// ── ToolContent ───────────────────────────────────────────────────────────────

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn("border-t border-border/60", className)}
    {...props}
  />
);

// ── ToolInput ─────────────────────────────────────────────────────────────────

export type ToolInputProps = ComponentProps<"div"> & {
  input?: unknown;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("p-2 space-y-1.5", className)} {...props}>
    <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      Parameters
    </h4>
    <div className="rounded bg-muted/50 overflow-hidden">
      <CodeBlock
        code={JSON.stringify(input ?? {}, null, 2)}
        language="json"
      />
    </div>
  </div>
);

// ── ToolOutput ────────────────────────────────────────────────────────────────

export type ToolOutputProps = ComponentProps<"div"> & {
  output?: ReactNode;
  errorText?: string;
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  if (!(output || errorText)) return null;

  let OutputNode: ReactNode;
  if (typeof output === "object" && output !== null && !isValidElement(output)) {
    OutputNode = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    OutputNode = <CodeBlock code={output} language="markdown" />;
  } else {
    OutputNode = <div>{output as ReactNode}</div>;
  }

  return (
    <div className={cn("p-2 space-y-1.5", className)} {...props}>
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "rounded overflow-x-auto text-xs",
          errorText
            ? "bg-destructive/10 text-destructive p-2"
            : "bg-muted/50",
        )}
      >
        {errorText && <div>{errorText}</div>}
        {!errorText && OutputNode}
      </div>
    </div>
  );
};
