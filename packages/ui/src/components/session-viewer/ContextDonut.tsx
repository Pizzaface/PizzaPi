import * as React from "react";
import { cn } from "@/lib/utils";
import type { TokenUsage } from "@/lib/types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import {
  contextPercent,
  donutColor,
  donutStroke,
  formatTokenCount,
} from "./context-donut-utils";

// Re-export helpers so existing imports from ContextDonut still work.
export { contextPercent, donutColor, donutStroke, formatTokenCount } from "./context-donut-utils";

// ── Helpers ──────────────────────────────────────────────────────────────────

// Pure helpers (contextPercent, donutColor, donutStroke, formatTokenCount)
// live in context-donut-utils.ts so tests can import them without pulling in
// React or aliased UI component dependencies.

// ── SVG Donut ────────────────────────────────────────────────────────────────

const SIZE = 28;
const STROKE_WIDTH = 3;
const RADIUS = (SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface DonutRingProps {
  pct: number;
  isCompacting?: boolean;
}

function DonutRing({ pct, isCompacting }: DonutRingProps) {
  const dashOffset = CIRCUMFERENCE - (pct / 100) * CIRCUMFERENCE;

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className={cn("shrink-0", isCompacting && "animate-spin")}
      style={isCompacting ? { animationDuration: "2s" } : undefined}
    >
      {/* Background track */}
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        className="stroke-muted-foreground/15"
        strokeWidth={STROKE_WIDTH}
      />
      {/* Filled arc */}
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        className={donutStroke(pct)}
        strokeWidth={STROKE_WIDTH}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
      />
    </svg>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export interface ContextDonutProps {
  tokenUsage: TokenUsage | null | undefined;
  contextWindow: number | undefined;
  isCompacting?: boolean;
  onCompact?: () => void;
  className?: string;
}

export function ContextDonut({
  tokenUsage,
  contextWindow,
  isCompacting,
  onCompact,
  className,
}: ContextDonutProps) {
  const [showConfirm, setShowConfirm] = React.useState(false);

  // Don't render if we don't have both data points
  if (!tokenUsage || !contextWindow || contextWindow <= 0) return null;

  const pct = contextPercent(tokenUsage, contextWindow);
  // Only show the donut when we have real context token data — cumulative
  // input is not a valid proxy and would show wildly inflated percentages.
  if (pct == null) return null;

  const ctxTokens = tokenUsage.contextTokens!;
  const tooltipLines = [
    `Context: ${formatTokenCount(ctxTokens)} / ${formatTokenCount(contextWindow)} tokens (${Math.round(pct)}%)`,
    `Output: ${formatTokenCount(tokenUsage.output)}`,
    tokenUsage.cacheRead ? `Cache read: ${formatTokenCount(tokenUsage.cacheRead)}` : null,
    tokenUsage.cacheWrite ? `Cache write: ${formatTokenCount(tokenUsage.cacheWrite)}` : null,
    isCompacting ? "Compacting…" : "Click to compact",
  ].filter(Boolean);

  return (
    <>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                if (onCompact && !isCompacting) setShowConfirm(true);
              }}
              disabled={isCompacting || !onCompact}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors",
                "hover:bg-muted/60 disabled:opacity-50 disabled:cursor-not-allowed",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                donutColor(pct),
                className,
              )}
              aria-label={`Context usage: ${Math.round(pct)}%. Click to compact.`}
            >
              <DonutRing pct={pct} isCompacting={isCompacting} />
              <span className="tabular-nums text-[0.65rem] font-medium hidden sm:inline">
                {Math.round(pct)}%
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs max-w-64">
            {tooltipLines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Compact context?</AlertDialogTitle>
            <AlertDialogDescription>
              This will summarize the conversation so far and replace it with a
              compact summary to free up context window space. The full history
              is preserved but the agent will only see the summary going forward.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
            <div>Context: {formatTokenCount(ctxTokens)} / {formatTokenCount(contextWindow)} tokens ({Math.round(pct)}%)</div>
            <div>Output: {formatTokenCount(tokenUsage.output)}</div>
            {tokenUsage.cacheRead ? <div>Cache read: {formatTokenCount(tokenUsage.cacheRead)}</div> : null}
            {tokenUsage.cacheWrite ? <div>Cache write: {formatTokenCount(tokenUsage.cacheWrite)}</div> : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogPrimitive.Action asChild>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  onCompact?.();
                }}
              >
                Compact
              </Button>
            </AlertDialogPrimitive.Action>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
