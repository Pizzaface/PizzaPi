/**
 * SigilPill — inline rendered component for [[type:id params]] tokens.
 *
 * Renders as a compact, interactive pill with:
 * - Type-colored background with icon
 * - Rich HoverCard preview with resolved metadata
 * - Clickable link when a URL is available
 * - Loading shimmer during resolve
 * - Status-aware coloring
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useSigilRegistry, useSigilResolve, useSigilTriggerResolve, useSigilGeneration } from "./SigilContext";
import { SigilIcon } from "./SigilIcon";
import { ExternalLinkIcon, CheckIcon, CopyIcon } from "lucide-react";
import { ActionSigil } from "./ActionSigil";
import { TimeSigilPill } from "./TimeSigilPill";
import { SigilHoverCard } from "./SigilHoverCard";
import { usePizzaPiNav, isPizzaPiUrl } from "./PizzaPiNavContext";

// ── SigilInline (Streamdown bridge) ──────────────────────────────────────────

export interface SigilPillProps {
  type: string;
  id: string;
  params: Record<string, string>;
  raw: string;
}

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

  if (type === "action") {
    return <ActionSigil variant={id} params={params} raw={raw} />;
  }

  // Adaptive time sigils get their own live-ticking component
  const TIME_SIGIL_TYPES = new Set(["time", "countdown", "timestamp", "when", "at", "timer"]);
  if (TIME_SIGIL_TYPES.has(type)) {
    return <TimeSigilPill type={type} id={id} params={params} raw={raw} />;
  }

  return <SigilPill type={type} id={id} params={params} raw={raw} />;
}

// ── SigilPill ────────────────────────────────────────────────────────────────

export function SigilPill({ type, id, params, raw }: SigilPillProps) {
  const registry = useSigilRegistry();
  const config = registry.getConfig(type);
  const canonicalType = registry.resolveType(type);
  const typeLabel = params.label ?? registry.getLabel(type);

  // Resolve enrichment data.
  // `generation` changes on server restart/reconnect (cache invalidation),
  // ensuring the effect re-fires even when type/id/params haven't changed.
  const triggerResolve = useSigilTriggerResolve();
  const generation = useSigilGeneration();
  const resolved = useSigilResolve(canonicalType, id);
  useEffect(() => {
    if (id) triggerResolve(canonicalType, id, params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canonicalType, id, triggerResolve, params, generation]);

  const displayText = resolved.data?.title ?? params.label ?? (id || canonicalType);
  const statusParam = resolved.data?.status ?? params.status ?? params.conclusion;
  const statusColor = statusParam ? getStatusColor(statusParam) : undefined;
  const rawHref = params.link ?? params.href ?? (resolved.data?.url ? String(resolved.data.url) : undefined);
  const href = rawHref && isSafeUrl(rawHref) ? rawHref : undefined;
  const author = resolved.data?.author ? String(resolved.data.author) : undefined;
  const description = resolved.data?.description
    ? String(resolved.data.description)
    : registry.getDescription(type);
  const isLoading = resolved.loading;
  const isPizzaPi = isPizzaPiUrl(href);
  const navigatePizzaPi = usePizzaPiNav();

  // ── Pill element ───────────────────────────────────────────────────────

  const pillClasses = cn(
    // Layout
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
    // Typography
    "text-[11px] font-semibold leading-tight align-baseline",
    // Interaction
    "select-none whitespace-nowrap",
    "transition-all duration-150 ease-out",
    // Border
    "ring-1 ring-inset",
    // Loading shimmer
    isLoading && "animate-pulse",
    // Status or type color
    statusColor ?? config.colorClass,
    // Link-specific
    href && "cursor-pointer no-underline hover:scale-[1.03] hover:shadow-sm active:scale-[0.98]",
    !href && "cursor-default",
  );

  const pillInner = (
    <>
      <SigilIcon name={config.icon ?? "hash"} className="size-3 shrink-0 opacity-80" />
      <span className="truncate max-w-[24ch]">{displayText}</span>
      {statusParam && (
        <span className={cn(
          "rounded-full px-1 py-px text-[9px] font-bold uppercase tracking-wider",
          "bg-black/10 dark:bg-white/10",
        )}>
          {statusParam}
        </span>
      )}
      {href && !isPizzaPi && <ExternalLinkIcon className="size-2.5 shrink-0 opacity-50" />}
    </>
  );

  const pill = href ? (
    <a
      href={isPizzaPi ? undefined : href}
      target={isPizzaPi ? undefined : "_blank"}
      rel={isPizzaPi ? undefined : "noopener noreferrer"}
      role="link"
      className={pillClasses}
      data-sigil={raw}
      onClick={(e) => {
        e.stopPropagation();
        if (isPizzaPi) {
          e.preventDefault();
          navigatePizzaPi(href!);
        }
      }}
    >
      {pillInner}
    </a>
  ) : (
    <span className={pillClasses} data-sigil={raw}>
      {pillInner}
    </span>
  );

  // ── HoverCard preview ──────────────────────────────────────────────────

  const hasPreview = id || description || author || statusParam;
  if (!hasPreview) return pill;

  return (
    <SigilHoverCard pill={pill}>
      <div className="flex flex-col gap-1.5">
        {/* Header: icon + type label */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <SigilIcon name={config.icon ?? "hash"} className="size-3.5 opacity-60" />
          <span className="font-medium">{typeLabel}</span>
        </div>

        {/* Title / ID */}
        {id && (
          <div className="text-sm font-semibold text-foreground leading-snug">
            {resolved.data?.title && resolved.data.title !== id ? (
              <>
                <span>{String(resolved.data.title)}</span>
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  #{id}
                </span>
              </>
            ) : (
              <span className="font-mono">{id}</span>
            )}
          </div>
        )}

        {/* Description */}
        {description && (
          <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
            {description}
          </p>
        )}

        {/* Meta row: author + status */}
        {(author || statusParam) && (
          <div className="flex items-center gap-2 pt-0.5">
            {author && (
              <span className="text-[11px] text-muted-foreground">
                by <span className="font-medium text-foreground">{author}</span>
              </span>
            )}
            {statusParam && (
              <span className={cn(
                "inline-flex items-center rounded-full px-1.5 py-px",
                "text-[10px] font-bold uppercase tracking-wider",
                "ring-1 ring-inset",
                getStatusColor(statusParam) ?? "bg-muted text-muted-foreground ring-border",
              )}>
                {statusParam}
              </span>
            )}
          </div>
        )}

        {/* Link — full-width tappable button so mobile users can navigate */}
        {href && !isPizzaPi && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "flex items-center justify-center gap-1.5 mt-1 w-full rounded-md px-3 py-2",
              "text-xs font-medium",
              "bg-muted hover:bg-muted/80 text-foreground",
              "ring-1 ring-inset ring-border",
              "transition-colors cursor-pointer no-underline",
            )}
          >
            <ExternalLinkIcon className="size-3 shrink-0" />
            <span className="truncate">{prettifyUrl(href)}</span>
          </a>
        )}
        {href && isPizzaPi && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); navigatePizzaPi(href!); }}
            className={cn(
              "flex items-center justify-center gap-1.5 mt-1 w-full rounded-md px-3 py-2",
              "text-xs font-medium",
              "bg-muted hover:bg-muted/80 text-foreground",
              "ring-1 ring-inset ring-border",
              "transition-colors cursor-pointer",
            )}
          >
            <span>Open in app →</span>
          </button>
        )}

        {/* Raw sigil syntax */}
        <div className="flex items-center gap-1 pt-0.5 text-[10px] text-muted-foreground/50">
          <code className="truncate font-mono">{raw}</code>
          <CopyButton text={raw} />
        </div>
      </div>
    </SigilHoverCard>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Allowlist URL schemes for sigil links.
 * Blocks javascript:, data:, vbscript:, and any other potentially dangerous scheme.
 */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "pizzapi:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function getStatusColor(status: string): string | undefined {
  switch (status) {
    case "success":
    case "merged":
    case "passed":
    case "healthy":
      return "bg-green-500/20 text-green-800 dark:text-green-300 ring-green-500/35";
    case "failure":
    case "failed":
    case "error":
      return "bg-red-500/20 text-red-800 dark:text-red-300 ring-red-500/35";
    case "closed":
      return "bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30";
    case "open":
    case "running":
    case "pending":
      return "bg-blue-500/20 text-blue-800 dark:text-blue-300 ring-blue-500/35";
    case "draft":
    case "neutral":
    case "skipped":
      return "bg-zinc-500/20 text-zinc-800 dark:text-zinc-300 ring-zinc-500/35";
    case "cancelled":
    case "timed_out":
      return "bg-amber-500/20 text-amber-800 dark:text-amber-300 ring-amber-500/35";
    default:
      return undefined;
  }
}

/** Shorten a URL for display: strip protocol, trailing slash. */
function prettifyUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** Tiny copy-to-clipboard button with check feedback. */
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
