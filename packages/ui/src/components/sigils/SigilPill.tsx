/**
 * SigilPill — inline rendered component for [[type:id params]] tokens.
 *
 * Renders as a compact pill with an icon, label, and optional tooltip.
 * Styling is driven by the SigilRegistry based on type.
 */
import { useEffect, useMemo } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useSigilRegistry, useSigilResolve, useSigilTriggerResolve } from "./SigilContext";
import { SigilIcon } from "./SigilIcon";

export interface SigilPillProps {
  /** Sigil type (after alias resolution) */
  type: string;
  /** Primary identifier */
  id: string;
  /** Key-value params */
  params: Record<string, string>;
  /** Original raw text for copy/debug */
  raw: string;
}

/**
 * The component rendered by Streamdown for <sigil> elements.
 * Reads data attributes set by the rehype plugin.
 */
export function SigilInline(props: Record<string, unknown>) {
  const type = (props["data-sigil-type"] as string) ?? "";
  const id = (props["data-sigil-id"] as string) ?? "";
  const raw = (props["data-sigil-raw"] as string) ?? "";
  const paramsJson = props["data-sigil-params"] as string | undefined;

  const params = useMemo(() => {
    if (!paramsJson) return {};
    try {
      return JSON.parse(paramsJson) as Record<string, string>;
    } catch {
      return {};
    }
  }, [paramsJson]);

  return <SigilPill type={type} id={id} params={params} raw={raw} />;
}

export function SigilPill({ type, id, params, raw }: SigilPillProps) {
  const registry = useSigilRegistry();
  const config = registry.getConfig(type);
  const canonicalType = registry.resolveType(type);
  const label = params.label ?? registry.getLabel(type);
  const description = registry.getDescription(type);

  // Trigger resolve for enrichment data
  const triggerResolve = useSigilTriggerResolve();
  const resolved = useSigilResolve(canonicalType, id);
  useEffect(() => {
    if (id) triggerResolve(canonicalType, id);
  }, [canonicalType, id, triggerResolve]);

  // Build display text: prefer resolved title > label param > raw id
  const displayId = resolved.data?.title ?? params.label ?? (id || canonicalType);

  // Status: prefer resolved status > param
  const statusParam = resolved.data?.status ?? params.status ?? params.conclusion;
  const statusColorClass = statusParam ? getStatusColor(statusParam) : undefined;

  const pill = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5",
        "text-xs font-medium leading-none align-baseline",
        "cursor-default select-none whitespace-nowrap",
        "transition-colors hover:brightness-110",
        statusColorClass ?? config.colorClass,
      )}
      data-sigil={raw}
    >
      <SigilIcon name={config.icon ?? "hash"} className="size-3 shrink-0" />
      <span className="truncate max-w-[20ch]">{displayId}</span>
      {statusParam && (
        <span className="opacity-70 text-[10px]">{statusParam}</span>
      )}
    </span>
  );

  // Wrap in tooltip if there's a description or extra params
  const tooltipLines = buildTooltipLines(label, description, params, canonicalType, id, resolved.data);
  if (tooltipLines.length === 0) return pill;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{pill}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs">
          {tooltipLines.map((line, i) => (
            <div key={i} className={i === 0 ? "font-medium" : "opacity-80"}>
              {line}
            </div>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getStatusColor(status: string): string | undefined {
  switch (status) {
    case "success":
    case "merged":
    case "passed":
    case "healthy":
      return "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/25";
    case "failure":
    case "failed":
    case "error":
    case "closed":
      return "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/25";
    case "open":
    case "running":
    case "pending":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/25";
    case "draft":
    case "neutral":
    case "skipped":
      return "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400 border-zinc-500/25";
    case "cancelled":
    case "timed_out":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25";
    default:
      return undefined;
  }
}

function buildTooltipLines(
  label: string,
  description: string | undefined,
  params: Record<string, string>,
  type: string,
  id: string,
  resolvedData?: Record<string, unknown>,
): string[] {
  const lines: string[] = [];

  // Title line: "Pull Request #55" or "Branch: main"
  if (id) {
    lines.push(`${label}: ${id}`);
  } else {
    lines.push(label);
  }

  // Resolved title (if different from id)
  if (resolvedData?.title && resolvedData.title !== id) {
    lines.push(String(resolvedData.title));
  }

  // Resolved author
  if (resolvedData?.author) {
    lines.push(`by ${resolvedData.author}`);
  }

  // Description from service def
  if (description) {
    lines.push(description);
  }

  // Non-label, non-status params as extra info
  const extraParams = Object.entries(params).filter(
    ([k]) => k !== "label" && k !== "status" && k !== "conclusion",
  );
  for (const [key, val] of extraParams) {
    lines.push(`${key}: ${val}`);
  }

  return lines;
}
