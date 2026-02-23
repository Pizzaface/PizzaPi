import * as React from "react";
import { cn } from "@/lib/utils";
import { Loader2Icon, CheckCircle2Icon, XCircleIcon } from "lucide-react";

/**
 * Shared card shell used by tool-execution cards in the session viewer.
 *
 * Provides a consistent outer wrapper with the dark card styling.
 */
export function ToolCardShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-100 text-xs",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Standard header row for tool cards.
 */
export function ToolCardHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Left side of a ToolCardHeader – icon + title.
 */
export function ToolCardTitle({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {icon}
      {children}
    </div>
  );
}

/**
 * Right side of a ToolCardHeader – status badges.
 */
export function ToolCardActions({ children }: { children: React.ReactNode }) {
  return <div className="flex shrink-0 items-center gap-2">{children}</div>;
}

/**
 * A body section of a tool card with a bottom border.
 */
export function ToolCardSection({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-b border-zinc-800/60 px-4 py-2.5", className)}>
      {children}
    </div>
  );
}

// ── Status Pill ──────────────────────────────────────────────────────────────

export type StatusPillVariant =
  | "streaming"
  | "success"
  | "error"
  | "info"
  | "neutral";

const pillStyles: Record<StatusPillVariant, string> = {
  streaming:
    "border-zinc-700 bg-zinc-800 text-zinc-400",
  success:
    "border-emerald-800/60 bg-emerald-900/30 text-emerald-400",
  error:
    "border-red-800/60 bg-red-900/30 text-red-400",
  info:
    "border-amber-800/60 bg-amber-900/20 text-amber-400",
  neutral:
    "border-zinc-700 bg-zinc-800 text-zinc-500",
};

const pillIcons: Record<StatusPillVariant, React.ReactNode> = {
  streaming: <Loader2Icon className="size-3 animate-spin" />,
  success: <CheckCircle2Icon className="size-3" />,
  error: <XCircleIcon className="size-3" />,
  info: null,
  neutral: null,
};

/**
 * Compact pill badge used for tool-card statuses (Spawning, Failed, Spawned, etc.)
 */
export function StatusPill({
  variant,
  icon,
  children,
}: {
  variant: StatusPillVariant;
  /** Override the default icon for the variant */
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
        pillStyles[variant],
      )}
    >
      {icon !== undefined ? icon : pillIcons[variant]}
      {children}
    </span>
  );
}
