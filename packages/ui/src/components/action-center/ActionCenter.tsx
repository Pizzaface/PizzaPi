/**
 * ActionCenter — right-side drawer showing all attention items grouped by category.
 *
 * Uses Radix Dialog as a slide-in sheet (no separate sheet dependency needed).
 * Groups: Needs Response → Running → Completed.
 * Each group is collapsible with a count badge.
 */
import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X, BellOff, ChevronDown, ChevronRight, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAttentionItemsByCategory, CATEGORY_ORDER } from "@/attention";
import type { AttentionCategory, AttentionItem } from "@/attention/types";
import { AttentionCard } from "./AttentionCard";

// ── Category display config ─────────────────────────────────────────────────

const CATEGORY_DISPLAY: Record<
  AttentionCategory,
  { label: string; color: string; badgeColor: string }
> = {
  needs_response: {
    label: "Needs Response",
    color: "text-amber-400",
    badgeColor: "bg-amber-500/20 text-amber-400",
  },
  running: {
    label: "Running",
    color: "text-blue-400",
    badgeColor: "bg-blue-500/20 text-blue-400",
  },
  completed: {
    label: "Completed",
    color: "text-emerald-400",
    badgeColor: "bg-emerald-500/20 text-emerald-400",
  },
  info: {
    label: "Info",
    color: "text-muted-foreground",
    badgeColor: "bg-muted text-muted-foreground",
  },
};

// ── Category Group ──────────────────────────────────────────────────────────

interface CategoryGroupProps {
  category: AttentionCategory;
  items: AttentionItem[];
  onItemClick?: (item: AttentionItem) => void;
  defaultExpanded?: boolean;
}

function CategoryGroup({ category, items, onItemClick, defaultExpanded = true }: CategoryGroupProps) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const display = CATEGORY_DISPLAY[category] ?? CATEGORY_DISPLAY.info;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 px-4 py-2 hover:bg-muted/30 transition-colors"
      >
        <div className="shrink-0 text-muted-foreground/60">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </div>
        <span className={cn("text-xs font-semibold uppercase tracking-wider", display.color)}>
          {display.label}
        </span>
        <span
          className={cn(
            "inline-flex items-center justify-center min-w-[1.25rem] h-5 rounded-full px-1.5 text-[10px] font-bold",
            display.badgeColor,
          )}
        >
          {items.length}
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-1.5 px-3 pb-3">
          {items.map((item) => (
            <AttentionCard
              key={item.id}
              item={item}
              onClick={onItemClick ? () => onItemClick(item) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── ActionCenter Sheet ──────────────────────────────────────────────────────

interface ActionCenterProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigateToSession?: (sessionId: string) => void;
}

export function ActionCenter({ open, onOpenChange, onNavigateToSession }: ActionCenterProps) {
  const grouped = useAttentionItemsByCategory();

  const handleItemClick = React.useCallback(
    (item: AttentionItem) => {
      onNavigateToSession?.(item.sessionId);
      onOpenChange(false);
    },
    [onNavigateToSession, onOpenChange],
  );

  const isEmpty = grouped.size === 0;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* Overlay */}
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-[70] bg-black/40",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        />

        {/* Sheet content — slides in from right */}
        <DialogPrimitive.Content
          className={cn(
            "fixed top-0 right-0 z-[70] h-full w-full sm:w-96 border-l bg-background shadow-xl",
            "flex flex-col overflow-hidden outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "duration-200",
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3 shrink-0">
            <div className="flex items-center gap-2">
              <Inbox className="size-4 text-muted-foreground" />
              <DialogPrimitive.Title className="text-sm font-semibold">
                Action Center
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                Items that need your attention: questions, plan reviews, and session status.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto">
            {isEmpty ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground/60 px-8">
                <BellOff className="size-10 opacity-40" />
                <p className="text-sm text-center">Nothing needs your attention right now.</p>
                <p className="text-xs text-center opacity-60">
                  Questions, plan reviews, and running sessions will appear here.
                </p>
              </div>
            ) : (
              <div className="flex flex-col py-2">
                {CATEGORY_ORDER.map((cat) => {
                  const items = grouped.get(cat);
                  if (!items || items.length === 0) return null;
                  return (
                    <CategoryGroup
                      key={cat}
                      category={cat}
                      items={items}
                      onItemClick={handleItemClick}
                      defaultExpanded={cat === "needs_response" || cat === "running"}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
