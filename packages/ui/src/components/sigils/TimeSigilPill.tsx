/**
 * TimeSigilPill — adaptive time sigil that live-updates its display.
 *
 * For [[time:...]] sigils: recomputes relative time every 30s
 *   ("5 min ago", "In 2 hours", "just now")
 *
 * For [[countdown:...]] sigils: ticks every second
 *   ("T-4:32", "T-0:05", "Done!")
 *
 * Both auto-clean their intervals on unmount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { useSigilRegistry, useSigilResolve, useSigilTriggerResolve, useSigilGeneration } from "./SigilContext";
import { SigilIcon } from "./SigilIcon";
import { CheckIcon, CopyIcon } from "lucide-react";

// ── Time formatting (client-side, no server round-trip needed after first resolve) ──

function formatRelativeTime(targetMs: number, nowMs: number): string {
  const diffMs = nowMs - targetMs;
  const absDiff = Math.abs(diffMs);
  const isFuture = diffMs < 0;

  if (absDiff < 30_000) return "just now";

  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(absDiff / 60_000);
  const hours = Math.floor(absDiff / 3_600_000);
  const days = Math.floor(absDiff / 86_400_000);

  const wrap = (s: string) => (isFuture ? `In ${s}` : `${s} ago`);

  if (seconds < 60) return wrap(`${seconds}s`);
  if (minutes < 60) return wrap(`${minutes} min`);
  if (hours < 24) return wrap(`${hours} hour${hours !== 1 ? "s" : ""}`);
  if (days < 30) return wrap(`${days} day${days !== 1 ? "s" : ""}`);

  const date = new Date(targetMs);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getMonth()]} ${date.getDate()}${date.getFullYear() !== new Date(nowMs).getFullYear() ? `, ${date.getFullYear()}` : ""}`;
}

function formatCountdown(targetMs: number, nowMs: number): string {
  const remaining = targetMs - nowMs;
  if (remaining <= 0) return "Done!";

  const totalSeconds = Math.ceil(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");

  if (hours > 0) return `T-${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `T-${minutes}:${pad(seconds)}`;
}

// ── Component ────────────────────────────────────────────────────────────────

export interface TimeSigilPillProps {
  type: string;         // "time" or "countdown"
  id: string;           // The time string (ISO, HH:MMUTC, duration, etc.)
  params: Record<string, string>;
  raw: string;
}

export function TimeSigilPill({ type, id, params, raw }: TimeSigilPillProps) {
  const registry = useSigilRegistry();
  const canonicalType = registry.resolveType(type);
  const config = registry.getConfig(type);
  const typeLabel = params.label ?? registry.getLabel(type);

  // Resolve from service to get the target timestamp
  const triggerResolve = useSigilTriggerResolve();
  const generation = useSigilGeneration();
  const resolved = useSigilResolve(canonicalType, id);

  useEffect(() => {
    if (id) triggerResolve(canonicalType, id, params);
  }, [canonicalType, id, triggerResolve, params, generation]);

  // Extract timestamp from resolved data
  const targetTimestamp = resolved.data?.timestamp as number | undefined;
  const isCountdown = canonicalType === "countdown";
  const tickIntervalMs = isCountdown ? 1000 : 30_000;

  // Live-ticking state
  const [now, setNow] = useState(Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (targetTimestamp == null) return;

    // Start ticking
    setNow(Date.now());
    intervalRef.current = setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);

      // For countdown: stop ticking after "Done!"
      if (isCountdown && currentTime >= targetTimestamp) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    }, tickIntervalMs);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [targetTimestamp, tickIntervalMs, isCountdown]);

  // Compute display text
  const displayText = useMemo(() => {
    if (targetTimestamp == null) {
      // Before resolve completes, show the raw id
      return resolved.loading ? "..." : id;
    }
    return isCountdown
      ? formatCountdown(targetTimestamp, now)
      : formatRelativeTime(targetTimestamp, now);
  }, [targetTimestamp, now, isCountdown, id, resolved.loading]);

  // Countdown "Done!" state
  const isDone = isCountdown && targetTimestamp != null && now >= targetTimestamp;

  // Color class — countdowns shift to green when done
  const pillColorClass = isDone
    ? "bg-green-500/15 text-green-700 dark:text-green-400 ring-green-500/25"
    : config.colorClass;

  const description = resolved.data?.description
    ? String(resolved.data.description)
    : registry.getDescription(type);

  // ── Pill element ─────────────────────────────────────────────────────

  const pillClasses = cn(
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
    "text-[11px] font-semibold leading-tight align-baseline",
    "select-none whitespace-nowrap",
    "transition-all duration-150 ease-out",
    "ring-1 ring-inset",
    resolved.loading && "animate-pulse",
    pillColorClass,
    "cursor-default",
  );

  // For countdowns, add a subtle pulse when < 1 minute
  const isUrgent = isCountdown && targetTimestamp != null && !isDone && (targetTimestamp - now) < 60_000;

  const pill = (
    <span
      className={cn(pillClasses, isUrgent && "animate-pulse")}
      data-sigil={raw}
    >
      <SigilIcon
        name={isDone ? "check-circle" : (config.icon ?? "clock")}
        className="size-3 shrink-0 opacity-80"
      />
      <span className={cn("truncate max-w-[24ch]", isCountdown && "font-mono tabular-nums")}>
        {displayText}
      </span>
    </span>
  );

  // ── HoverCard ────────────────────────────────────────────────────────

  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>{pill}</HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="center"
        className="w-auto min-w-[180px] max-w-[280px] p-3"
      >
        <div className="flex flex-col gap-1.5">
          {/* Header */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <SigilIcon name={config.icon ?? "clock"} className="size-3.5 opacity-60" />
            <span className="font-medium">{typeLabel}</span>
          </div>

          {/* Display text */}
          <div className="text-sm font-semibold text-foreground leading-snug">
            {displayText}
          </div>

          {/* Description / ISO timestamp */}
          {description && (
            <p className="text-xs text-muted-foreground leading-relaxed font-mono">
              {description}
            </p>
          )}

          {/* Status for countdowns */}
          {isCountdown && (
            <div className="flex items-center gap-2 pt-0.5">
              <span className={cn(
                "inline-flex items-center rounded-full px-1.5 py-px",
                "text-[10px] font-bold uppercase tracking-wider",
                "ring-1 ring-inset",
                isDone
                  ? "bg-green-500/15 text-green-700 dark:text-green-400 ring-green-500/25"
                  : "bg-rose-500/15 text-rose-700 dark:text-rose-400 ring-rose-500/25",
              )}>
                {isDone ? "complete" : "counting"}
              </span>
            </div>
          )}

          {/* Raw sigil syntax */}
          <div className="flex items-center gap-1 pt-0.5 text-[10px] text-muted-foreground/50">
            <code className="truncate font-mono">{raw}</code>
            <CopyButton text={raw} />
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

// ── CopyButton (duplicated from SigilPill to keep this self-contained) ───────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); handleCopy(); }}
      className="shrink-0 rounded p-0.5 hover:bg-muted transition-colors"
      aria-label="Copy sigil"
    >
      {copied
        ? <CheckIcon className="size-2.5 text-green-500" />
        : <CopyIcon className="size-2.5 opacity-60 hover:opacity-100" />
      }
    </button>
  );
}
