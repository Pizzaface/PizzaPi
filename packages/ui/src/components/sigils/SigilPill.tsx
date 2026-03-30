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
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { useSigilRegistry, useSigilResolve, useSigilTriggerResolve } from "./SigilContext";
import { SigilIcon } from "./SigilIcon";
import { ExternalLinkIcon, CheckIcon, CopyIcon } from "lucide-react";

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

  return <SigilPill type={type} id={id} params={params} raw={raw} />;
}

// ── SigilPill ────────────────────────────────────────────────────────────────

export function SigilPill({ type, id, params, raw }: SigilPillProps) {
  const registry = useSigilRegistry();
  const config = registry.getConfig(type);
  const canonicalType = registry.resolveType(type);
  const typeLabel = params.label ?? registry.getLabel(type);

  // Resolve enrichment data
  const triggerResolve = useSigilTriggerResolve();
  const resolved = useSigilResolve(canonicalType, id);
  useEffect(() => {
    if (id) triggerResolve(canonicalType, id, params);
  }, [canonicalType, id, triggerResolve, params]);

  const displayText = resolved.data?.title ?? params.label ?? (id || canonicalType);
  const statusParam = resolved.data?.status ?? params.status ?? params.conclusion;
  const statusColor = statusParam ? getStatusColor(statusParam) : undefined;
  const href = params.link ?? params.href ?? (resolved.data?.url ? String(resolved.data.url) : undefined);
  const author = resolved.data?.author ? String(resolved.data.author) : undefined;
  const description = resolved.data?.description
    ? String(resolved.data.description)
    : registry.getDescription(type);
  const isLoading = resolved.loading;

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
      {href && <ExternalLinkIcon className="size-2.5 shrink-0 opacity-50" />}
    </>
  );

  const pill = href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={pillClasses}
      data-sigil={raw}
      onClick={(e) => e.stopPropagation()}
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
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>{pill}</HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="center"
        className="w-auto min-w-[180px] max-w-[280px] p-3"
      >
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

          {/* Link hint */}
          {href && (
            <div className="flex items-center gap-1 pt-0.5 text-[10px] text-muted-foreground/60">
              <ExternalLinkIcon className="size-2.5" />
              <span className="truncate">{prettifyUrl(href)}</span>
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function getStatusColor(status: string): string | undefined {
  switch (status) {
    case "success":
    case "merged":
    case "passed":
    case "healthy":
      return "bg-green-500/15 text-green-700 dark:text-green-400 ring-green-500/25";
    case "failure":
    case "failed":
    case "error":
      return "bg-red-500/15 text-red-700 dark:text-red-400 ring-red-500/25";
    case "closed":
      return "bg-red-500/10 text-red-600 dark:text-red-400 ring-red-500/20";
    case "open":
    case "running":
    case "pending":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-400 ring-blue-500/25";
    case "draft":
    case "neutral":
    case "skipped":
      return "bg-zinc-500/15 text-zinc-700 dark:text-zinc-400 ring-zinc-500/25";
    case "cancelled":
    case "timed_out":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400 ring-amber-500/25";
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
