import * as React from "react";
import type {
  TriggerRecord,
  TriggerType,
  SessionTriggerConfig,
  CostTriggerConfig,
  CustomEventTriggerConfig,
  TimerTriggerConfig,
} from "@pizzapi/protocol";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Trash2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Type-display metadata ────────────────────────────────────────────────────

interface TriggerMeta {
  icon: string;
  label: string;
}

const TRIGGER_META: Record<TriggerType, TriggerMeta> = {
  session_ended: { icon: "🏁", label: "Session Ended" },
  session_idle: { icon: "💤", label: "Session Idle" },
  session_error: { icon: "❌", label: "Session Error" },
  cost_exceeded: { icon: "💰", label: "Cost Exceeded" },
  custom_event: { icon: "📢", label: "Custom Event" },
  timer: { icon: "⏱️", label: "Timer" },
};

// ── Config summary helpers ────────────────────────────────────────────────────

function getConfigSummary(type: TriggerType, config: TriggerRecord["config"]): string {
  switch (type) {
    case "session_ended":
    case "session_idle":
    case "session_error": {
      const c = config as SessionTriggerConfig;
      if (c.sessionIds === "*") return "All sessions";
      return `Watching ${c.sessionIds.length} session${c.sessionIds.length !== 1 ? "s" : ""}`;
    }
    case "cost_exceeded": {
      const c = config as CostTriggerConfig;
      return `Threshold: $${c.threshold.toFixed(2)}`;
    }
    case "custom_event": {
      const c = config as CustomEventTriggerConfig;
      return `Event: ${c.eventName}`;
    }
    case "timer": {
      const c = config as TimerTriggerConfig;
      return `${c.delaySec}s${c.recurring ? " · recurring" : ""}`;
    }
  }
}

// ── Timestamp formatting ──────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString();
}

// ── Individual trigger row ────────────────────────────────────────────────────

function TriggerRow({ trigger, onCancel }: { trigger: TriggerRecord; onCancel?: (triggerId: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const meta = TRIGGER_META[trigger.type];
  const summary = getConfigSummary(trigger.type, trigger.config);

  const isTimer = trigger.type === "timer";
  const timerConfig = isTimer ? (trigger.config as TimerTriggerConfig) : null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {/* Collapsed row */}
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            "w-full flex items-center gap-2 px-3 py-2.5 text-left",
            "hover:bg-muted/40 transition-colors group",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          aria-expanded={open}
        >
          {/* Expand icon */}
          <span className="text-muted-foreground shrink-0">
            {open ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </span>

          {/* Type icon + label */}
          <span className="text-sm shrink-0" aria-hidden>
            {meta.icon}
          </span>
          <span className="text-xs font-medium text-foreground/90 shrink-0 hidden sm:inline">
            {meta.label}
          </span>

          {/* Config summary */}
          <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
            {summary}
          </span>

          {/* Right-side metadata */}
          <div className="flex items-center gap-1.5 shrink-0 ml-1">
            {/* Recurring badge for timer */}
            {timerConfig?.recurring && (
              <Badge variant="secondary" className="text-[0.6rem] h-4 px-1">
                recurring
              </Badge>
            )}

            {/* Delivery mode badge */}
            <Badge
              variant="outline"
              className={cn(
                "text-[0.6rem] h-4 px-1.5 hidden xs:inline-flex",
                trigger.delivery.mode === "inject"
                  ? "border-blue-500/40 text-blue-400"
                  : "border-amber-500/40 text-amber-400",
              )}
            >
              {trigger.delivery.mode}
            </Badge>

            {/* Firing count */}
            <span className="text-[0.65rem] text-muted-foreground tabular-nums hidden sm:inline">
              {trigger.maxFirings != null
                ? `${trigger.firingCount}/${trigger.maxFirings}`
                : `${trigger.firingCount} fired`}
            </span>

            {/* Last fired */}
            {trigger.lastFiredAt && (
              <span
                className="text-[0.65rem] text-muted-foreground hidden md:inline"
                title={`Last fired: ${new Date(trigger.lastFiredAt).toLocaleString()}`}
              >
                {formatTimestamp(trigger.lastFiredAt)}
              </span>
            )}
          </div>
        </button>
      </CollapsibleTrigger>

      {/* Expanded details */}
      <CollapsibleContent>
        <div className="px-4 pb-3 pt-1 space-y-2 border-t border-border/50 bg-muted/20">
          {/* Delivery mode (mobile fallback) */}
          <div className="flex items-center gap-2 xs:hidden">
            <span className="text-[0.65rem] text-muted-foreground uppercase tracking-wide">Delivery</span>
            <Badge
              variant="outline"
              className={cn(
                "text-[0.6rem] h-4 px-1.5",
                trigger.delivery.mode === "inject"
                  ? "border-blue-500/40 text-blue-400"
                  : "border-amber-500/40 text-amber-400",
              )}
            >
              {trigger.delivery.mode}
            </Badge>
          </div>

          {/* Firings (mobile fallback) */}
          <div className="flex items-center gap-2 sm:hidden">
            <span className="text-[0.65rem] text-muted-foreground uppercase tracking-wide">Fired</span>
            <span className="text-xs text-foreground/80">
              {trigger.maxFirings != null
                ? `${trigger.firingCount} / ${trigger.maxFirings}`
                : trigger.firingCount}
            </span>
          </div>

          {/* Message template */}
          {trigger.message && (
            <div>
              <div className="text-[0.65rem] text-muted-foreground uppercase tracking-wide mb-1">
                Message template
              </div>
              <div className="text-xs text-foreground/80 font-mono bg-muted/50 rounded px-2 py-1 whitespace-pre-wrap break-words">
                {trigger.message}
              </div>
            </div>
          )}

          {/* Expires at */}
          {trigger.expiresAt && (
            <div className="flex items-center gap-2">
              <span className="text-[0.65rem] text-muted-foreground uppercase tracking-wide">Expires</span>
              <span className="text-xs text-foreground/80">
                {new Date(trigger.expiresAt).toLocaleString()}
              </span>
            </div>
          )}

          {/* Last fired (mobile fallback) */}
          {trigger.lastFiredAt && (
            <div className="flex items-center gap-2 md:hidden">
              <span className="text-[0.65rem] text-muted-foreground uppercase tracking-wide">Last fired</span>
              <span className="text-xs text-foreground/80">
                {new Date(trigger.lastFiredAt).toLocaleString()}
              </span>
            </div>
          )}

          {/* Full config JSON */}
          <div>
            <div className="text-[0.65rem] text-muted-foreground uppercase tracking-wide mb-1">
              Config
            </div>
            <pre className="text-[0.65rem] text-foreground/70 font-mono bg-muted/50 rounded px-2 py-1 overflow-x-auto whitespace-pre">
              {JSON.stringify(trigger.config, null, 2)}
            </pre>
          </div>

          {/* Delete button */}
          {onCancel && (
            <div className="pt-1">
              <Button
                variant="destructive"
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel(trigger.id);
                }}
              >
                <Trash2 className="size-3" />
                Delete Trigger
              </Button>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Main TriggerPanel ─────────────────────────────────────────────────────────

export interface TriggerPanelProps {
  triggers: TriggerRecord[];
  onCancel?: (triggerId: string) => void;
  onCreateOpen?: () => void;
  canManage?: boolean;
}

export function TriggerPanel({ triggers, onCancel, onCreateOpen, canManage }: TriggerPanelProps) {
  if (triggers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 py-6 text-center">
        <span className="text-2xl" aria-hidden>
          ⏱️
        </span>
        <p className="text-xs text-muted-foreground">No active triggers</p>
        {canManage && onCreateOpen && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1.5 mt-2"
            onClick={onCreateOpen}
          >
            <Plus className="size-3" />
            Create Trigger
          </Button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="divide-y divide-border">
        {triggers.map((trigger) => (
          <TriggerRow key={trigger.id} trigger={trigger} onCancel={canManage ? onCancel : undefined} />
        ))}
      </div>
      {canManage && onCreateOpen && (
        <div className="px-3 py-2 border-t border-border/50">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1.5 w-full"
            onClick={onCreateOpen}
          >
            <Plus className="size-3" />
            Create Trigger
          </Button>
        </div>
      )}
    </div>
  );
}
