/**
 * AttentionCard — renders a single AttentionItem as a compact card.
 *
 * Shows: session name, kind icon, time ago, brief description.
 * Primary action: navigate to source session (via onClick).
 * Visual urgency based on category.
 */
import * as React from "react";
import {
  HelpCircle,
  FileCheck,
  Zap,
  ShieldCheck,
  KeyRound,
  Loader2,
  Play,
  Activity,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AttentionItem, AttentionItemKind } from "@/attention/types";

// ── Kind → icon/label mapping ───────────────────────────────────────────────

const KIND_CONFIG: Record<
  AttentionItemKind,
  { icon: React.ReactNode; label: string }
> = {
  question: {
    icon: <HelpCircle className="size-3.5" />,
    label: "Question",
  },
  plan_review: {
    icon: <FileCheck className="size-3.5" />,
    label: "Plan review",
  },
  trigger_response: {
    icon: <Zap className="size-3.5" />,
    label: "Trigger response",
  },
  plugin_trust: {
    icon: <ShieldCheck className="size-3.5" />,
    label: "Plugin trust",
  },
  oauth: {
    icon: <KeyRound className="size-3.5" />,
    label: "OAuth",
  },
  compacting: {
    icon: <Loader2 className="size-3.5 animate-spin" />,
    label: "Compacting",
  },
  child_running: {
    icon: <Play className="size-3.5" />,
    label: "Child running",
  },
  agent_active: {
    icon: <Activity className="size-3.5" />,
    label: "Active",
  },
  session_complete: {
    icon: <CheckCircle2 className="size-3.5" />,
    label: "Completed",
  },
};

// ── Category → visual treatment ─────────────────────────────────────────────

const CATEGORY_STYLES = {
  needs_response: {
    border: "border-amber-500/30",
    bg: "bg-amber-950/20 hover:bg-amber-950/30",
    icon: "text-amber-400",
    text: "text-amber-300",
  },
  running: {
    border: "border-blue-500/20",
    bg: "bg-blue-950/10 hover:bg-blue-950/20",
    icon: "text-blue-400",
    text: "text-blue-300",
  },
  completed: {
    border: "border-emerald-500/20",
    bg: "bg-emerald-950/10 hover:bg-emerald-950/20",
    icon: "text-emerald-400",
    text: "text-emerald-300",
  },
  info: {
    border: "border-border/50",
    bg: "bg-muted/10 hover:bg-muted/20",
    icon: "text-muted-foreground",
    text: "text-muted-foreground",
  },
};

function formatRelativeTime(isoTs: string): string {
  const now = Date.now();
  const then = new Date(isoTs).getTime();
  if (isNaN(then)) return "";
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

interface AttentionCardProps {
  item: AttentionItem;
  onClick?: () => void;
}

export const AttentionCard = React.memo(function AttentionCard({ item, onClick }: AttentionCardProps) {
  const kindCfg = KIND_CONFIG[item.kind] ?? KIND_CONFIG.agent_active;
  const styles = CATEGORY_STYLES[item.category] ?? CATEGORY_STYLES.info;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer",
        styles.border,
        styles.bg,
      )}
    >
      {/* Kind icon */}
      <div className={cn("mt-0.5 shrink-0", styles.icon)}>
        {kindCfg.icon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs font-medium text-foreground/90 truncate">
            {item.sessionName || `Session ${item.sessionId.slice(0, 8)}…`}
          </span>
          <span className={cn("text-[10px] font-medium", styles.text)}>
            {kindCfg.label}
          </span>
        </div>

        {/* Description from payload */}
        {item.payload != null && typeof item.payload === "object" &&
          typeof (item.payload as Record<string, unknown>).summary === "string" &&
          Boolean((item.payload as Record<string, unknown>).summary) && (
          <p className="text-[11px] text-muted-foreground/70 mt-0.5 truncate">
            {(item.payload as Record<string, unknown>).summary as string}
          </p>
        )}
        {item.kind === "plan_review" && item.payload != null && typeof item.payload === "object" && "title" in (item.payload as Record<string, unknown>) && (
          <p className="text-[11px] text-muted-foreground/70 mt-0.5 truncate">
            {String((item.payload as Record<string, unknown>).title)}
          </p>
        )}

        <span className="text-[10px] text-muted-foreground/50 mt-0.5 block">
          {formatRelativeTime(item.createdAt)}
        </span>
      </div>
    </button>
  );
});
