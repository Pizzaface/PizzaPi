/**
 * TriggersPanel — status-first view of triggers, grouped by linked session.
 *
 * Shows "Awaiting Response" triggers prominently at the top, then linked
 * sessions with expandable event history, and finally non-session triggers.
 *
 * Supports real-time `trigger_status_update` events for live progress text
 * (e.g. "Working on step 3/7") without creating new history entries.
 *
 * Fetches from GET /api/sessions/:id/triggers and listens for viewer
 * socket events for instant refresh.
 */
import * as React from "react";
import {
  Globe,
  Settings,
  Clock,
  Link,
  Wrench,
  ChevronDown,
  ChevronRight,
  Send,
  RefreshCw,
  Loader2,
  ArrowDownCircle,
  ArrowUpCircle,
  Zap,
  Plus,
  BellRing,
  Trash2,
  Zap as ZapIcon,
  BookOpen,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  XCircle,
  Pencil,
  Copy,
  Check,
  Filter,
  Cpu,
  Layers,
  Sparkles,
  GitPullRequest,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { cronFromSchedule, scheduleFromCron, type RecurringSchedule } from "@/lib/cron-schedule";
import type { JsonValue, ServiceTriggerDef, ServiceTriggerParamDef } from "@pizzapi/protocol";

// ── Shared trigger utilities (re-exported for backward compat) ─────────────
export type { TriggerHistoryEntry } from "../attention/trigger-utils";
export { isPendingTrigger, RESPONSE_TRIGGER_TYPES } from "../attention/trigger-utils";
import type { TriggerHistoryEntry } from "../attention/trigger-utils";
import { isPendingTrigger, RESPONSE_TRIGGER_TYPES } from "../attention/trigger-utils";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TriggerSubscription {
  subscriptionId?: string;
  triggerType: string;
  runnerId: string;
  params?: Record<string, JsonValue>;
  filters?: Array<{ field: string; value: string | number | boolean | Array<string | number | boolean>; op?: "eq" | "contains" }>;
  filterMode?: "and" | "or";
}

/** Ephemeral status update for a trigger (not persisted in history). */
interface TriggerStatusUpdate {
  triggerId: string;
  sourceSessionId: string;
  statusText: string;
  ts: string;
}

function formatParamValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function renderParamValueBadges(
  key: string,
  value: JsonValue,
  className: string,
): React.ReactNode {
  if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
    return value.map((item, index) => (
      <Badge key={`${key}:${String(item)}:${index}`} variant="outline" className={className}>
        {key}={String(item)}
      </Badge>
    ));
  }

  return (
    <Badge key={key} variant="outline" className={className}>
      {key}={formatParamValue(value)}
    </Badge>
  );
}

/** A linked child session derived from trigger history. */
export interface LinkedSessionGroup {
  /** Session ID of the linked child */
  source: string;
  /** All trigger events from this session, most recent first */
  events: TriggerHistoryEntry[];
  /** The most recent pending trigger (no response), if any */
  pendingTrigger: TriggerHistoryEntry | null;
  /** Most recent trigger type */
  lastType: string;
  /** Most recent trigger timestamp */
  lastTs: string;
  /** Summary from the most recent trigger */
  lastSummary?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatRelativeTime(isoTs: string, nowMs: number): string {
  const then = new Date(isoTs).getTime();
  if (isNaN(then)) return isoTs;
  const diffMs = nowMs - then;
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

/** Renders a relative timestamp that ticks internally every 5s. */
function RelativeTime({ isoTs }: { isoTs: string }) {
  const [now, setNow] = React.useState(Date.now);

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  return <>{formatRelativeTime(isoTs, now)}</>;
}

/** Returns a lucide icon for the trigger source */
function SourceIcon({ source, className }: { source: string; className?: string }) {
  const src = source.toLowerCase();
  if (src.includes("github") || src.includes("pr") || src.includes("issue")) {
    return <GitPullRequest className={cn("size-3.5 text-muted-foreground", className)} />;
  }
  if (src.includes("webhook") || src.includes("http")) {
    return <Globe className={cn("size-3.5 text-muted-foreground", className)} />;
  }
  if (src.includes("cron") || src.includes("schedule") || src.includes("time")) {
    return <Clock className={cn("size-3.5 text-muted-foreground", className)} />;
  }
  if (src.includes("service")) {
    return <Settings className={cn("size-3.5 text-muted-foreground", className)} />;
  }
  if (src === "api" || src.startsWith("external")) {
    return <Globe className={cn("size-3.5 text-muted-foreground", className)} />;
  }
  if (src.length >= 8 && /^[a-z0-9-]+$/.test(src)) {
    return <Cpu className={cn("size-3.5 text-muted-foreground", className)} />;
  }
  return <Wrench className={cn("size-3.5 text-muted-foreground", className)} />;
}

function sourceLabel(source: string): string {
  if (!source || source === "api") return "API";
  if (source.startsWith("external:")) return source.slice(9);
  return source;
}

/** Truncate an identifier for compact display. */
function truncateId(id: string, maxLen = 12): string {
  if (id.length <= maxLen) return id;
  return id.slice(0, maxLen) + "…";
}

function truncateSubscriptionLabel(id?: string, fallback?: string, maxLen = 18): string {
  if (!id) return fallback ?? "subscription";
  return truncateId(id, maxLen);
}

/** Derive the status of a linked session from its most recent trigger. */
function deriveSessionStatus(group: LinkedSessionGroup): {
  label: string;
  color: "amber" | "emerald" | "red" | "blue" | "zinc";
  icon: React.ReactNode;
} {
  if (group.pendingTrigger) {
    const type = group.pendingTrigger.type;
    if (type === "ask_user_question") {
      return { label: "asking question", color: "blue", icon: <HelpCircle className="size-3.5" /> };
    }
    if (type === "plan_review") {
      return { label: "awaiting plan review", color: "amber", icon: <Clock className="size-3.5" /> };
    }
    if (type === "session_complete") {
      return { label: "completed", color: "emerald", icon: <CheckCircle2 className="size-3.5" /> };
    }
    if (type === "escalate") {
      return { label: "escalated", color: "red", icon: <AlertCircle className="size-3.5" /> };
    }
    return { label: "awaiting response", color: "amber", icon: <Clock className="size-3.5" /> };
  }

  // No pending trigger — check the most recent event's response
  const latest = group.events[0];
  if (!latest) return { label: "active", color: "emerald", icon: <CheckCircle2 className="size-3.5" /> };

  if (latest.type === "session_complete") {
    const action = latest.response?.action;
    if (action === "followUp") {
      return { label: "running", color: "blue", icon: <RefreshCw className="size-3.5" /> };
    }
    if (action === "ack") {
      return { label: "completed", color: "zinc", icon: <CheckCircle2 className="size-3.5" /> };
    }
    return { label: "completed", color: "emerald", icon: <CheckCircle2 className="size-3.5" /> };
  }

  if (latest.type === "session_linked") {
    return { label: "connected", color: "emerald", icon: <Link className="size-3.5" /> };
  }

  if (latest.response) {
    return { label: "responded", color: "emerald", icon: <CheckCircle2 className="size-3.5" /> };
  }

  return { label: "active", color: "emerald", icon: <CheckCircle2 className="size-3.5" /> };
}

/** Group triggers by linked session source. Returns groups sorted by most recent first. */
export function groupByLinkedSession(triggers: TriggerHistoryEntry[]): {
  sessionGroups: LinkedSessionGroup[];
  otherEvents: TriggerHistoryEntry[];
} {
  const groupMap = new Map<string, TriggerHistoryEntry[]>();
  const otherEvents: TriggerHistoryEntry[] = [];

  for (const t of triggers) {
    // Only group inbound triggers from non-external sources (child sessions)
    if (t.direction === "inbound" && t.source !== "api" && !t.source.startsWith("external:")) {
      const existing = groupMap.get(t.source);
      if (existing) {
        existing.push(t);
      } else {
        groupMap.set(t.source, [t]);
      }
    } else {
      otherEvents.push(t);
    }
  }

  const sessionGroups: LinkedSessionGroup[] = [];
  for (const [source, events] of groupMap) {
    // Events are already sorted most-recent-first from the API
    const pendingTrigger = events.find(isPendingTrigger) ?? null;
    sessionGroups.push({
      source,
      events,
      pendingTrigger,
      lastType: events[0].type,
      lastTs: events[0].ts,
      lastSummary: events[0].summary,
    });
  }

  // Sort: groups with pending triggers first, then by most recent event
  sessionGroups.sort((a, b) => {
    if (a.pendingTrigger && !b.pendingTrigger) return -1;
    if (!a.pendingTrigger && b.pendingTrigger) return 1;
    return new Date(b.lastTs).getTime() - new Date(a.lastTs).getTime();
  });

  return { sessionGroups, otherEvents };
}

/**
 * Unified source grouping — groups ALL triggers by source, regardless of
 * direction or whether they're from child sessions, services, or external.
 * Each source gets one accordion. Pending sources float to the top.
 */
export interface SourceGroup {
  /** Raw source value */
  source: string;
  /** Human-readable label */
  label: string;
  /** All trigger events from this source, most recent first */
  events: TriggerHistoryEntry[];
  /** The most recent pending trigger (no response), if any */
  pendingTrigger: TriggerHistoryEntry | null;
  /** Whether this source looks like a linked child session (vs service/external) */
  isLinkedSession: boolean;
  /** Most recent trigger timestamp */
  lastTs: string;
  /** Summary from the most recent trigger */
  lastSummary?: string;
}

export function groupTriggersBySource(triggers: TriggerHistoryEntry[]): SourceGroup[] {
  const map = new Map<string, TriggerHistoryEntry[]>();

  for (const t of triggers) {
    const key = t.source || "unknown";
    const existing = map.get(key);
    if (existing) {
      existing.push(t);
    } else {
      map.set(key, [t]);
    }
  }

  const groups: SourceGroup[] = [];
  for (const [source, events] of map) {
    const pendingTrigger = events.find(isPendingTrigger) ?? null;
    // A source looks like a linked session if it has inbound triggers and isn't "api" or "external:*"
    const isLinkedSession = events.some(
      (e) => e.direction === "inbound" && source !== "api" && !source.startsWith("external:"),
    );
    groups.push({
      source,
      label: sourceLabel(source),
      events,
      pendingTrigger,
      isLinkedSession,
      lastTs: events[0].ts,
      lastSummary: events[0].summary,
    });
  }

  // Sort: pending first, then by most recent event
  groups.sort((a, b) => {
    if (a.pendingTrigger && !b.pendingTrigger) return -1;
    if (!a.pendingTrigger && b.pendingTrigger) return 1;
    return new Date(b.lastTs).getTime() - new Date(a.lastTs).getTime();
  });

  return groups;
}

// ── Incomplete trigger detection (used by /new warning) ────────────────────

export interface IncompleteTriggerItem {
  /** Display label (session name or ID) */
  label: string;
  /** What's incomplete */
  reason: string;
  /** Source session ID */
  source: string;
}

/**
 * Analyze trigger history and return a list of incomplete items.
 *
 * "Incomplete" means:
 * - A linked session with a pending interactive trigger (ask_user_question, plan_review, escalate)
 * - A linked session that is still active (no terminal session_complete, or a session_complete answered with followUp)
 *
 * Sessions that have sent session_complete are considered done once the child
 * actually stopped. A followUp response resumes the child, so it remains incomplete.
 */
export function getIncompleteTriggers(triggers: TriggerHistoryEntry[]): IncompleteTriggerItem[] {
  const { sessionGroups } = groupByLinkedSession(triggers);
  const items: IncompleteTriggerItem[] = [];

  for (const group of sessionGroups) {
    const label = group.lastSummary || group.source.slice(0, 12);

    // Has a pending interactive trigger (needs a response)
    if (group.pendingTrigger) {
      const type = group.pendingTrigger.type;
      // session_complete means the child is done — not truly "incomplete"
      if (type === "session_complete") continue;
      if (type === "ask_user_question") {
        items.push({ label, reason: "Waiting for your answer", source: group.source });
      } else if (type === "plan_review") {
        items.push({ label, reason: "Awaiting plan review", source: group.source });
      } else if (type === "escalate") {
        items.push({ label, reason: "Escalated — needs attention", source: group.source });
      } else {
        items.push({ label, reason: `Awaiting response to ${type}`, source: group.source });
      }
      continue;
    }

    // Events are most-recent-first; find() picks the newest session_complete
    const latestComplete = group.events.find((e) => e.type === "session_complete");
    if (latestComplete && latestComplete.response?.action !== "followUp") continue;

    // Still active (connected, no terminal session_complete)
    items.push({ label, reason: "Still running", source: group.source });
  }

  return items;
}

// ── Send Trigger Dialog ────────────────────────────────────────────────────

interface SendTriggerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  onSent: () => void;
  triggerDefs?: ServiceTriggerDef[];
}

function SendTriggerDialog({ open, onOpenChange, sessionId, onSent, triggerDefs }: SendTriggerDialogProps) {
  const [triggerType, setTriggerType] = React.useState("");
  const [source, setSource] = React.useState("");
  const [payloadText, setPayloadText] = React.useState("{}");
  const [deliverAs, setDeliverAs] = React.useState<"steer" | "followUp">("steer");
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setTriggerType("");
      setSource("");
      setPayloadText("{}");
      setDeliverAs("steer");
      setError(null);
    }
  }, [open]);

  const handleSend = React.useCallback(async () => {
    if (!triggerType.trim()) {
      setError("Trigger type is required.");
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadText) as Record<string, unknown>;
      if (typeof payload !== "object" || Array.isArray(payload)) {
        setError("Payload must be a JSON object.");
        return;
      }
    } catch {
      setError("Payload must be valid JSON.");
      return;
    }

    setSending(true);
    setError(null);

    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/trigger`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: triggerType.trim(),
          source: source.trim() || undefined,
          payload,
          deliverAs,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }

      onOpenChange(false);
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSending(false);
    }
  }, [sessionId, triggerType, source, payloadText, deliverAs, onOpenChange, onSent]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg border-border/80 bg-zinc-950/95 backdrop-blur-xl shadow-2xl">
        <DialogHeader className="pb-2 border-b border-border/50">
          <DialogTitle className="flex items-center gap-2.5 text-base font-semibold text-foreground">
            <span className="size-7 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
              <Zap className="size-4" />
            </span>
            Send Trigger
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3.5 py-1">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground/90 uppercase tracking-wider flex items-center gap-1">
              Trigger Type <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              {...(triggerDefs && triggerDefs.length > 0 ? { list: "trigger-type-suggestions" } : {})}
              placeholder="e.g. webhook, custom_event"
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value)}
              className="w-full rounded-lg border border-border/80 bg-background/80 px-3 py-2 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary/50 transition-colors"
            />
            {triggerDefs && triggerDefs.length > 0 && (
              <datalist id="trigger-type-suggestions">
                {triggerDefs.map((def) => (
                  <option key={def.type} value={def.type}>{def.label}</option>
                ))}
              </datalist>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground/90 uppercase tracking-wider flex items-center justify-between">
              <span>Source</span>
              <span className="text-[11px] font-normal text-muted-foreground/60">optional</span>
            </label>
            <input
              type="text"
              placeholder="e.g. github, godmother"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full rounded-lg border border-border/80 bg-background/80 px-3 py-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary/50 transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground/90 uppercase tracking-wider">
              Payload (JSON)
            </label>
            <textarea
              rows={4}
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              className="w-full rounded-lg border border-border/80 bg-background/80 px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary/50 transition-colors resize-y leading-relaxed"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground/90 uppercase tracking-wider">
              Deliver As
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all",
                  deliverAs === "steer"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                    : "border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                <input
                  type="radio"
                  name="deliverAs"
                  value="steer"
                  checked={deliverAs === "steer"}
                  onChange={() => setDeliverAs("steer")}
                  className="sr-only"
                />
                <Zap className="size-3.5 shrink-0 text-amber-400" />
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-medium leading-none">Steer (interrupt)</span>
                  <span className="text-[10px] text-muted-foreground/80 mt-0.5">Interrupt turn</span>
                </div>
              </label>

              <label
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all",
                  deliverAs === "followUp"
                    ? "border-blue-500/40 bg-blue-500/10 text-blue-300"
                    : "border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                <input
                  type="radio"
                  name="deliverAs"
                  value="followUp"
                  checked={deliverAs === "followUp"}
                  onChange={() => setDeliverAs("followUp")}
                  className="sr-only"
                />
                <Clock className="size-3.5 shrink-0 text-blue-400" />
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-medium leading-none">Follow-Up (queue)</span>
                  <span className="text-[10px] text-muted-foreground/80 mt-0.5">Queue after turn</span>
                </div>
              </label>
            </div>
          </div>

          {error && (
            <p className="rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive flex items-center gap-2">
              <AlertCircle className="size-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="pt-2 border-t border-border/50 gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={sending} className="h-8 px-3 text-xs">
            Cancel
          </Button>
          <Button size="sm" onClick={handleSend} disabled={sending || !triggerType.trim()} className="h-8 px-3.5 text-xs font-semibold gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground">
            {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Event Row (inside expanded session group) ──────────────────────────────

function EventRow({ entry }: { entry: TriggerHistoryEntry }) {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const hasPayload = Object.keys(entry.payload).length > 0;
  const payloadStr = hasPayload ? JSON.stringify(entry.payload, null, 2) : null;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (payloadStr) {
      void navigator.clipboard.writeText(payloadStr);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="border-b border-border/40 last:border-0 hover:bg-white/[0.015] transition-colors">
      <button
        type="button"
        onClick={() => hasPayload && setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
          hasPayload ? "hover:bg-muted/40 cursor-pointer" : "cursor-default",
        )}
      >
        <div className="shrink-0">
          {entry.direction === "inbound" ? (
            <ArrowDownCircle className="size-3.5 text-blue-400/80" />
          ) : (
            <ArrowUpCircle className="size-3.5 text-violet-400/80" />
          )}
        </div>

        <span className="text-xs font-mono font-medium text-foreground/90 truncate">{entry.type}</span>

        {entry.deliverAs === "steer" ? (
          <Badge variant="outline" className="px-1.5 py-0.5 text-[10px] font-mono border-amber-500/30 text-amber-400/90 bg-amber-500/5">
            steer
          </Badge>
        ) : (
          <Badge variant="outline" className="px-1.5 py-0.5 text-[10px] font-mono border-blue-500/30 text-blue-400/90 bg-blue-500/5">
            follow-up
          </Badge>
        )}

        <span className="text-[11px] text-muted-foreground/60 ml-auto shrink-0 font-mono">
          <RelativeTime isoTs={entry.ts} />
        </span>

        {entry.response && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 shrink-0 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
            ✓ {entry.response.action ?? "responded"}
          </span>
        )}

        {hasPayload && (
          <div className="shrink-0 text-muted-foreground/50 ml-0.5">
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </div>
        )}
      </button>

      {expanded && payloadStr && (
        <div className="px-3 pb-2 pt-0.5 relative group">
          <div className="relative">
            <pre className="rounded-lg bg-zinc-950/80 border border-border/60 p-2.5 text-[10px] font-mono text-zinc-300 overflow-auto max-h-40 whitespace-pre-wrap break-all leading-relaxed shadow-inner">
              {payloadStr}
            </pre>
            <button
              type="button"
              onClick={handleCopy}
              className="absolute top-2 right-2 p-1 rounded-md bg-zinc-900 border border-zinc-700 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors shadow-sm"
              title="Copy payload JSON"
            >
              {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Linked Session Card ────────────────────────────────────────────────────

interface LinkedSessionCardProps {
  group: LinkedSessionGroup;
  statusUpdates: Map<string, TriggerStatusUpdate>;
}

function LinkedSessionCard({ group, statusUpdates }: LinkedSessionCardProps) {
  const [expanded, setExpanded] = React.useState(false);
  const status = deriveSessionStatus(group);
  const isPending = !!group.pendingTrigger;

  // Find the most recent status update for any trigger in this group
  const latestStatusUpdate = React.useMemo(() => {
    let latest: TriggerStatusUpdate | null = null;
    for (const event of group.events) {
      const update = statusUpdates.get(event.triggerId);
      if (update && (!latest || new Date(update.ts) > new Date(latest.ts))) {
        latest = update;
      }
    }
    return latest;
  }, [group.events, statusUpdates]);

  const colorMap = {
    amber: {
      border: "border-amber-500/40",
      bg: "bg-gradient-to-b from-amber-500/[0.08] to-zinc-900/30",
      highlightBar: "from-transparent via-amber-400 to-transparent",
      text: "text-amber-300",
      badge: "border-amber-500/40 bg-amber-500/10 text-amber-400",
      icon: "text-amber-400",
      iconBg: "bg-amber-500/20 border-amber-500/30",
      pulse: true,
    },
    blue: {
      border: "border-blue-500/40",
      bg: "bg-gradient-to-b from-blue-500/[0.08] to-zinc-900/30",
      highlightBar: "from-transparent via-blue-400 to-transparent",
      text: "text-blue-300",
      badge: "border-blue-500/40 bg-blue-500/10 text-blue-400",
      icon: "text-blue-400",
      iconBg: "bg-blue-500/20 border-blue-500/30",
      pulse: true,
    },
    red: {
      border: "border-red-500/40",
      bg: "bg-gradient-to-b from-red-500/[0.08] to-zinc-900/30",
      highlightBar: "from-transparent via-red-400 to-transparent",
      text: "text-red-300",
      badge: "border-red-500/40 bg-red-500/10 text-red-400",
      icon: "text-red-400",
      iconBg: "bg-red-500/20 border-red-500/30",
      pulse: true,
    },
    emerald: {
      border: "border-emerald-500/30",
      bg: "bg-zinc-900/40",
      highlightBar: "from-transparent via-emerald-400/40 to-transparent",
      text: "text-emerald-300",
      badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
      icon: "text-emerald-400",
      iconBg: "bg-emerald-500/10 border-emerald-500/20",
      pulse: false,
    },
    zinc: {
      border: "border-border/60",
      bg: "bg-zinc-900/30",
      highlightBar: "from-transparent via-zinc-500/20 to-transparent",
      text: "text-muted-foreground",
      badge: "border-border/80 bg-muted/40 text-muted-foreground",
      icon: "text-muted-foreground",
      iconBg: "bg-muted/40 border-border/40",
      pulse: false,
    },
  };

  const colors = colorMap[status.color];

  return (
    <div className={cn("rounded-xl border overflow-hidden shadow-md relative transition-all", colors.border, colors.bg)}>
      {isPending && (
        <div className={cn("absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r", colors.highlightBar)} />
      )}

      {/* Main clickable header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-3 p-3 text-left transition-colors hover:bg-white/[0.02]"
      >
        {/* Status icon badge */}
        <div className={cn("size-7 rounded-lg border flex items-center justify-center shrink-0 mt-0.5 shadow-sm", colors.iconBg, colors.icon, colors.pulse && "animate-pulse")}>
          {status.icon}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Session name + status */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-foreground truncate">
              {group.lastSummary || truncateId(group.source)}
            </span>
            <Badge
              variant="outline"
              className={cn("px-2 py-0.5 text-[10px] font-medium rounded-md shrink-0 capitalize", colors.badge)}
            >
              {status.label}
            </Badge>
          </div>

          {/* Pending trigger detail */}
          {isPending && (
            <div className="mt-1.5 p-2 rounded-lg bg-zinc-950/60 border border-border/50 space-y-1">
              <div className="flex items-center justify-between">
                <span className={cn("text-xs font-medium", colors.text)}>
                  {group.pendingTrigger!.type === "ask_user_question" && "Waiting for your answer"}
                  {group.pendingTrigger!.type === "plan_review" && "Waiting for plan approval"}
                  {group.pendingTrigger!.type === "session_complete" && "Session finished — needs acknowledgement"}
                  {group.pendingTrigger!.type === "escalate" && "Escalated — needs human attention"}
                  {!["ask_user_question", "plan_review", "session_complete", "escalate"].includes(group.pendingTrigger!.type) && `Awaiting response to ${group.pendingTrigger!.type}`}
                </span>
                <span className="text-[10px] text-muted-foreground/70 font-mono ml-2">
                  <RelativeTime isoTs={group.pendingTrigger!.ts} />
                </span>
              </div>
            </div>
          )}

          {/* Streaming status update */}
          {latestStatusUpdate && (
            <div className="mt-1.5 flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-blue-950/30 border border-blue-500/20">
              <Loader2 className="size-3 animate-spin text-blue-400 shrink-0" />
              <span className="text-[11px] text-blue-200/90 font-medium truncate">
                {latestStatusUpdate.statusText}
              </span>
            </div>
          )}

          {/* Non-pending: show last event summary */}
          {!isPending && !latestStatusUpdate && (
            <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground/70">
              <span>
                Last: <span className="font-mono text-foreground/80">{group.lastType}</span>
              </span>
              <span>·</span>
              <span className="font-mono text-muted-foreground/50">
                <RelativeTime isoTs={group.lastTs} />
              </span>
            </div>
          )}

          {/* Event count + session ID hint */}
          <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground/50">
            <span className="font-medium bg-muted/40 px-1.5 py-0.5 rounded border border-border/40">
              {group.events.length} event{group.events.length !== 1 ? "s" : ""}
            </span>
            {group.lastSummary && (
              <span className="font-mono text-muted-foreground/40 truncate">
                #{truncateId(group.source)}
              </span>
            )}
          </div>
        </div>

        {/* Expand chevron */}
        <div className="mt-0.5 shrink-0 text-muted-foreground/40 p-1 hover:text-foreground">
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </div>
      </button>

      {/* Expanded event history */}
      {expanded && (
        <div className={cn("border-t bg-zinc-950/40 divide-y divide-border/30", colors.border)}>
          {group.events.map((event) => (
            <EventRow key={event.triggerId} entry={event} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Collapsible Param Defs ──────────────────────────────────────────────────

function CollapsibleParamDefs({ params }: { params: ServiceTriggerParamDef[] }) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        {expanded ? <ChevronDown className="size-2.5" /> : <ChevronRight className="size-2.5" />}
        <span>{params.length} param{params.length !== 1 ? "s" : ""}</span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5 pl-3.5">
          {params.map((p) => (
            <div key={p.name} className="text-[10px] text-muted-foreground/70">
              <span className="font-mono text-foreground/80">{p.name}</span>
              <span className="text-muted-foreground/40">: {p.type}</span>
              {p.required && <span className="text-amber-400/70 ml-1 font-medium">required</span>}
              {p.multiselect && <span className="text-violet-400/70 ml-1">multiselect</span>}
              {p.enum && (
                <span className="text-muted-foreground/50 ml-1">
                  {"{" + p.enum.map(String).join(", ") + "}"}
                </span>
              )}
              {p.description && <span className="ml-1 text-muted-foreground/60">— {p.description}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Trigger Catalog Section ────────────────────────────────────────────────

interface TriggerCatalogSectionProps {
  sessionId: string;
  triggerDefs: ServiceTriggerDef[];
  subscriptions: TriggerSubscription[];
  onSubscriptionsChange: () => void;
}

function TriggerCatalogSection({ sessionId, triggerDefs, subscriptions, onSubscriptionsChange }: TriggerCatalogSectionProps) {
  const [collapsed, setCollapsed] = React.useState(true);
  const [pending, setPending] = React.useState<Set<string>>(new Set());
  const [paramFormOpen, setParamFormOpen] = React.useState<string | null>(null);
  const [editingSubscriptionId, setEditingSubscriptionId] = React.useState<string | null>(null);
  const [editMode, setEditMode] = React.useState(false);
  const [paramValues, setParamValues] = React.useState<Record<string, Record<string, string | string[]>>>({});
  const [paramError, setParamError] = React.useState<string | null>(null);
  const [filterValues, setFilterValues] = React.useState<Record<string, Record<string, string>>>({});
  const [filterMode, setFilterMode] = React.useState<Record<string, "and" | "or">>({});

  const subscriptionsByType = React.useMemo(() => {
    const map = new Map<string, TriggerSubscription[]>();
    for (const sub of subscriptions) {
      const existing = map.get(sub.triggerType);
      if (existing) existing.push(sub);
      else map.set(sub.triggerType, [sub]);
    }
    return map;
  }, [subscriptions]);

  const subscribedTypes = React.useMemo(
    () => new Set(subscriptions.map((s) => s.triggerType)),
    [subscriptions],
  );

  const handleUnsubscribe = React.useCallback(async (triggerType: string, subscriptionId?: string) => {
    const pendingKey = subscriptionId ?? triggerType;
    setPending((prev) => new Set([...prev, pendingKey]));
    try {
      const url = new URL(`/api/sessions/${encodeURIComponent(sessionId)}/trigger-subscriptions/${encodeURIComponent(triggerType)}`, window.location.origin);
      if (subscriptionId) url.searchParams.set("subscriptionId", subscriptionId);
      await fetch(url.toString().replace(window.location.origin, ""), { method: "DELETE", credentials: "include" });
      onSubscriptionsChange();
    } catch {
      // ignore
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(pendingKey);
        return next;
      });
    }
  }, [sessionId, onSubscriptionsChange]);

  const handleSubscribe = React.useCallback(async (
    triggerType: string,
    params?: Record<string, unknown>,
    filters?: Array<{ field: string; value: unknown; op?: string }>,
    filterMode?: string,
  ) => {
    setPending((prev) => new Set([...prev, triggerType]));
    setParamError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/trigger-subscriptions`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggerType, params, filters, filterMode }),
      });
      if (res.ok) {
        setParamFormOpen(null);
        setEditingSubscriptionId(null);
        setEditMode(false);
        onSubscriptionsChange();
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setParamError(data.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setParamError(err instanceof Error ? err.message : "Failed to subscribe");
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(triggerType);
        return next;
      });
    }
  }, [sessionId, onSubscriptionsChange]);

  const handleUpdate = React.useCallback(async (
    triggerType: string,
    subscriptionId?: string,
    params?: Record<string, unknown>,
    filters?: Array<{ field: string; value: unknown; op?: string }>,
    filterMode?: string,
  ) => {
    const pendingKey = subscriptionId ?? triggerType;
    setPending((prev) => new Set([...prev, pendingKey]));
    setParamError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/trigger-subscriptions/${encodeURIComponent(triggerType)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptionId, params, filters, filterMode }),
      });
      if (res.ok) {
        setParamFormOpen(null);
        setEditingSubscriptionId(null);
        setEditMode(false);
        onSubscriptionsChange();
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setParamError(data.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setParamError(err instanceof Error ? err.message : "Failed to update subscription");
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(pendingKey);
        return next;
      });
    }
  }, [sessionId, onSubscriptionsChange]);

  const handleToggle = React.useCallback((def: ServiceTriggerDef, isListening = false, subscriptionId?: string) => {
    const isSubscribed = subscribedTypes.has(def.type);
    const hasParams = def.params && def.params.length > 0;
    const hasOutputSchema = !!(def.schema as any)?.properties;

    if (isListening) {
      void handleUnsubscribe(def.type, subscriptionId);
    } else if (hasParams || hasOutputSchema) {
      setParamFormOpen(def.type);
      setEditingSubscriptionId(null);
      setEditMode(false);
      setParamError(null);
      const defaults: Record<string, string | string[]> = {};
      if (def.params) {
        for (const p of def.params) {
          if (p.multiselect) {
            defaults[p.name] = [];
          } else if (p.default !== undefined) {
            defaults[p.name] = formatParamValue(p.default);
          }
        }
      }
      setParamValues((prev) => ({ ...prev, [def.type]: { ...defaults, ...prev[def.type] } }));
    } else if (isSubscribed && !subscriptionId) {
      void handleUnsubscribe(def.type);
    } else {
      void handleSubscribe(def.type);
    }
  }, [subscribedTypes, handleUnsubscribe, handleSubscribe]);

  const handleEdit = React.useCallback((def: ServiceTriggerDef, subscription?: TriggerSubscription) => {
    setParamFormOpen(def.type);
    setEditingSubscriptionId(subscription?.subscriptionId ?? null);
    setEditMode(true);
    setParamError(null);

    const vals: Record<string, string | string[]> = {};
    const paramDefsByName = new Map((def.params ?? []).map((param) => [param.name, param]));
    if (subscription?.params) {
      for (const [k, v] of Object.entries(subscription.params)) {
        const paramDef = paramDefsByName.get(k);
        if (paramDef?.multiselect && Array.isArray(v)) {
          vals[k] = v.map(String);
        } else {
          vals[k] = formatParamValue(v);
        }
      }
    }
    if (def.params) {
      for (const p of def.params) {
        if (vals[p.name] !== undefined) continue;
        if (p.multiselect) {
          vals[p.name] = [];
        } else if (p.default !== undefined) {
          vals[p.name] = formatParamValue(p.default);
        }
      }
    }
    setParamValues((prev) => ({ ...prev, [def.type]: vals }));

    const fVals: Record<string, string> = {};
    if (subscription?.filters) {
      for (const f of subscription.filters) {
        fVals[f.field] = Array.isArray(f.value) ? f.value.map(String).join(",") : String(f.value);
      }
    }
    setFilterValues((prev) => ({ ...prev, [def.type]: fVals }));
    setFilterMode((prev) => ({ ...prev, [def.type]: subscription?.filterMode ?? "and" }));
  }, []);

  const handleParamSubmit = React.useCallback((def: ServiceTriggerDef) => {
    const vals = paramValues[def.type] ?? {};
    const params: Record<string, unknown> = {};

    for (const p of (def.params ?? [])) {
      const raw = vals[p.name];

      if (p.multiselect && p.enum) {
        const selected = Array.isArray(raw) ? raw : [];
        if (selected.length === 0 && p.required) {
          setParamError(`'${p.label}' requires at least one selection`);
          return;
        }
        if (selected.length === 0) continue;
        if (p.type === "number") {
          params[p.name] = selected.map(Number).filter((n) => !isNaN(n));
        } else if (p.type === "boolean") {
          params[p.name] = selected.map((v) => v === "true");
        } else {
          params[p.name] = selected;
        }
        continue;
      }

      const str = (typeof raw === "string" ? raw : "").trim();
      if (!str && p.required) {
        setParamError(`'${p.label}' is required`);
        return;
      }
      if (!str) continue;

      if (p.type === "json") {
        try {
          params[p.name] = JSON.parse(str);
        } catch {
          setParamError(`'${p.label}' must be valid JSON`);
          return;
        }
      } else if (p.type === "number") {
        const num = Number(str);
        if (isNaN(num)) {
          setParamError(`'${p.label}' must be a number`);
          return;
        }
        params[p.name] = num;
      } else if (p.type === "boolean") {
        params[p.name] = str === "true";
      } else {
        params[p.name] = str;
      }
    }

    const fVals = filterValues[def.type] ?? {};
    const filters: Array<{ field: string; value: unknown; op?: string }> = [];
    const schemaProps = (def.schema as any)?.properties ?? {};

    for (const [field, rawVal] of Object.entries(fVals)) {
      const str = rawVal.trim();
      if (!str) continue;
      const propDef = schemaProps[field];
      if (propDef?.type === "boolean") {
        filters.push({ field, value: str === "true", op: "eq" });
      } else if (propDef?.type === "number") {
        const num = Number(str);
        if (!isNaN(num)) filters.push({ field, value: num, op: "eq" });
      } else {
        filters.push({ field, value: str, op: "eq" });
      }
    }

    const fMode = filterMode[def.type] ?? "and";

    if (editMode) {
      void handleUpdate(
        def.type,
        editingSubscriptionId ?? undefined,
        Object.keys(params).length > 0 ? params : undefined,
        filters.length > 0 ? filters : undefined,
        filters.length > 0 ? fMode : undefined,
      );
    } else {
      void handleSubscribe(
        def.type,
        Object.keys(params).length > 0 ? params : undefined,
        filters.length > 0 ? filters : undefined,
        filters.length > 0 ? fMode : undefined,
      );
    }
  }, [paramValues, filterValues, filterMode, editMode, editingSubscriptionId, handleUpdate, handleSubscribe]);

  // Group triggerDefs by service prefix
  const groupedByService = React.useMemo(() => {
    const map = new Map<string, ServiceTriggerDef[]>();
    for (const def of triggerDefs) {
      const prefix = def.type.includes(":") ? def.type.split(":")[0] : "other";
      const list = map.get(prefix) ?? [];
      list.push(def);
      map.set(prefix, list);
    }
    return map;
  }, [triggerDefs]);

  return (
    <div className="p-3 space-y-3">
      {/* Available Triggers header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="size-6 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
            <Layers className="size-3.5" />
          </span>
          <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Available Triggers ({triggerDefs.length})
          </span>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="text-xs font-medium text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors px-2 py-1 rounded-md hover:bg-muted/40"
        >
          <span>{collapsed ? "Expand all" : "Collapse all"}</span>
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        </button>
      </div>

      {/* Service groups */}
      <div className="space-y-2.5">
        {Array.from(groupedByService.entries()).map(([service, defs]) => {
          const subscribedCount = defs.filter((d) => subscribedTypes.has(d.type)).length;
          return (
            <ServiceCatalogAccordion
              key={service}
              service={service}
              defs={defs}
              subscribedCount={subscribedCount}
              subscribedTypes={subscribedTypes}
              subscriptionsByType={subscriptionsByType}
              pending={pending}
              paramFormOpen={paramFormOpen}
              editingSubscriptionId={editingSubscriptionId}
              editMode={editMode}
              paramValues={paramValues}
              paramError={paramError}
              filterValues={filterValues}
              filterModeValues={filterMode}
              onToggle={handleToggle}
              onEdit={handleEdit}
              onUnsubscribe={handleUnsubscribe}
              onParamFormOpen={(type) => {
                setParamFormOpen(type);
                setEditingSubscriptionId(null);
                setEditMode(false);
                setParamError(null);
              }}
              onParamFormClose={() => {
                setParamFormOpen(null);
                setEditingSubscriptionId(null);
                setEditMode(false);
                setParamError(null);
              }}
              onParamValuesChange={setParamValues}
              onFilterValuesChange={setFilterValues}
              onFilterModeChange={setFilterMode}
              onParamSubmit={handleParamSubmit}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Service Catalog Accordion ──────────────────────────────────────────────

interface ServiceCatalogAccordionProps {
  service: string;
  defs: ServiceTriggerDef[];
  subscribedCount: number;
  subscribedTypes: Set<string>;
  subscriptionsByType: Map<string, TriggerSubscription[]>;
  pending: Set<string>;
  paramFormOpen: string | null;
  editingSubscriptionId: string | null;
  editMode: boolean;
  paramValues: Record<string, Record<string, string | string[]>>;
  paramError: string | null;
  filterValues: Record<string, Record<string, string>>;
  filterModeValues: Record<string, "and" | "or">;
  onToggle: (def: ServiceTriggerDef, isListening?: boolean, subscriptionId?: string) => void;
  onEdit: (def: ServiceTriggerDef, subscription?: TriggerSubscription) => void;
  onUnsubscribe: (triggerType: string, subscriptionId?: string) => void;
  onParamFormOpen: (type: string) => void;
  onParamFormClose: () => void;
  onParamValuesChange: React.Dispatch<React.SetStateAction<Record<string, Record<string, string | string[]>>>>;
  onFilterValuesChange: React.Dispatch<React.SetStateAction<Record<string, Record<string, string>>>>;
  onFilterModeChange: React.Dispatch<React.SetStateAction<Record<string, "and" | "or">>>;
  onParamSubmit: (def: ServiceTriggerDef) => void;
}

function ServiceCatalogAccordion({
  service,
  defs,
  subscribedCount,
  subscribedTypes,
  subscriptionsByType,
  pending,
  paramFormOpen,
  editingSubscriptionId,
  editMode,
  paramValues,
  paramError,
  filterValues,
  filterModeValues,
  onToggle,
  onEdit,
  onUnsubscribe,
  onParamFormOpen,
  onParamFormClose,
  onParamValuesChange,
  onFilterValuesChange,
  onFilterModeChange,
  onParamSubmit,
}: ServiceCatalogAccordionProps) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className={cn(
      "rounded-xl border overflow-hidden shadow-sm transition-all",
      subscribedCount > 0
        ? "border-emerald-500/30 bg-zinc-900/40"
        : "border-border/60 bg-zinc-900/30",
    )}>
      {/* Service Header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-white/[0.02] transition-colors"
      >
        <SourceIcon source={service} className="size-4 shrink-0" />
        <span className="text-xs font-semibold text-foreground/90 capitalize flex-1 text-left">
          {service}
        </span>
        <span className="text-[11px] text-muted-foreground/60">
          {defs.length} trigger{defs.length !== 1 ? "s" : ""}
        </span>
        {subscribedCount > 0 && (
          <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-bold border border-emerald-500/30">
            {subscribedCount}
          </span>
        )}
        <div className="shrink-0 text-muted-foreground/50 ml-1">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </div>
      </button>

      {/* Expanded trigger list */}
      {expanded && (
        <div className="border-t border-border/40 divide-y divide-border/30 bg-zinc-950/20">
          {defs.map((def) => {
            const triggerSubscriptions = subscriptionsByType.get(def.type) ?? [];
            const isSubscribed = triggerSubscriptions.length > 0;
            const isPendingToggle = pending.has(def.type);
            const isParamFormVisible = paramFormOpen === def.type;
            const hasParams = def.params && def.params.length > 0;
            const hasOutputSchema = !!(def.schema as any)?.properties;
            const isCronParam = def.type.startsWith("time:") && def.params?.some((p) => p.name === "cron");

            return (
              <div key={def.type} className="p-3 space-y-2 hover:bg-white/[0.01] transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-foreground">{def.label}</span>
                      {isSubscribed && (
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-emerald-500/40 text-emerald-400 shrink-0">
                          {triggerSubscriptions.length} active
                        </Badge>
                      )}
                      {hasParams && !isSubscribed && (
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-violet-500/30 text-violet-400/80 bg-violet-500/5">
                          configurable
                        </Badge>
                      )}
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground/60 block mt-0.5">
                      {def.type}
                    </span>
                    {def.description && (
                      <p className="text-[11px] text-muted-foreground/80 mt-1 leading-relaxed">
                        {def.description}
                      </p>
                    )}
                  </div>

                  {/* Add / Subscribe button */}
                  <button
                    type="button"
                    onClick={() => onToggle(def, false)}
                    disabled={isPendingToggle}
                    className={cn(
                      "inline-flex items-center gap-1 shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-all",
                      isSubscribed
                        ? "text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/10 border border-transparent hover:border-emerald-500/20"
                        : "bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm",
                      isPendingToggle && "opacity-50 cursor-not-allowed",
                    )}
                    title={isSubscribed ? "Add another subscription" : "Subscribe"}
                    aria-label={isSubscribed ? `Add another subscription for ${def.type}` : `Subscribe to ${def.type}`}
                  >
                    {isPendingToggle ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    {isSubscribed ? "Add" : "Subscribe"}
                  </button>
                </div>

                {/* Existing Subscriptions list */}
                {isSubscribed && (
                  <div className="mt-2 space-y-1.5">
                    {triggerSubscriptions.map((sub, index) => {
                      const subKey = sub.subscriptionId ?? `${def.type}-${index}`;
                      const isPendingSub = pending.has(subKey) || isPendingToggle;
                      const details: string[] = [];
                      const paramBadges: React.ReactNode[] = [];

                      if (sub.params && Object.keys(sub.params).length > 0) {
                        for (const [k, v] of Object.entries(sub.params)) {
                          details.push(`${k}=${formatParamValue(v)}`);
                          const badges = renderParamValueBadges(k, v, "px-1.5 py-0 text-[10px] h-4 border-emerald-500/30 text-emerald-400/90 bg-emerald-500/5 font-mono");
                          if (Array.isArray(badges)) paramBadges.push(...badges);
                          else paramBadges.push(badges);
                        }
                      }

                      if (sub.filters && sub.filters.length > 0) {
                        const mode = sub.filterMode === "or" ? "OR" : "AND";
                        const filterStrs = sub.filters.map((f) => `${f.field}${f.op === "contains" ? "~" : "="}${Array.isArray(f.value) ? f.value.map(String).join("|") : String(f.value)}`);
                        details.push(`${mode}(${filterStrs.join(", ")})`);
                      }

                      return (
                        <div key={subKey} className="rounded-lg border border-border/60 bg-zinc-900/60 p-2.5">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 min-w-0">
                              {details.length > 0 ? (
                                <div className="space-y-1">
                                  <p className="text-[10px] font-mono text-muted-foreground/70 truncate">
                                    {details.join(" · ")}
                                  </p>
                                  {paramBadges.length > 0 && (
                                    <div className="flex items-center gap-1 flex-wrap">
                                      {paramBadges}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <p className="text-[10px] text-muted-foreground/50 italic">No filters</p>
                              )}
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              {(hasParams || hasOutputSchema) && (
                                <button
                                  type="button"
                                  onClick={() => onEdit(def, sub)}
                                  disabled={isPendingSub}
                                  className={cn(
                                    "p-1 rounded-md transition-colors text-muted-foreground hover:text-blue-400 hover:bg-blue-500/10",
                                    isPendingSub && "opacity-50 cursor-not-allowed",
                                  )}
                                  title="Edit subscription"
                                  aria-label={`Edit subscription ${sub.subscriptionId ?? index + 1} for ${def.type}`}
                                >
                                  <Pencil className="size-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => onToggle(def, true, sub.subscriptionId)}
                                disabled={isPendingSub}
                                className={cn(
                                  "p-1 rounded-md transition-colors text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10",
                                  isPendingSub && "opacity-50 cursor-not-allowed",
                                )}
                                title="Remove subscription"
                                aria-label={`Delete subscription ${sub.subscriptionId ?? index + 1} for ${def.type}`}
                              >
                                {isPendingSub ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Collapsible param definitions when not subscribed */}
                {hasParams && !isSubscribed && !isParamFormVisible && def.params && (
                  <CollapsibleParamDefs params={def.params} />
                )}

                {/* Inline param form */}
                {isParamFormVisible && (hasParams || hasOutputSchema) && (
                  <div className="rounded-xl border border-blue-500/30 bg-blue-950/20 p-3.5 space-y-3 mt-2 shadow-inner">
                    <div className="flex items-center justify-between pb-2 border-b border-blue-500/20">
                      <span className="text-xs font-semibold text-blue-300 flex items-center gap-1.5">
                        <Sparkles className="size-3.5" />
                        {hasParams ? "Service params" : "Configure subscription"}
                      </span>
                    </div>

                    {/* Param inputs */}
                    {def.params?.map((p) => {
                      const currentVal = paramValues[def.type]?.[p.name];
                      const selectedArr = Array.isArray(currentVal) ? currentVal : [];

                      if (isCronParam && p.name === "cron") {
                        return (
                          <div key={p.name} className="space-y-1.5">
                            <label className="text-xs font-medium text-foreground/90 flex items-center gap-1">
                              Schedule {p.required && <span className="text-destructive">*</span>}
                            </label>
                            <CronScheduleBuilder
                              value={typeof currentVal === "string" ? currentVal : ""}
                              onChange={(val) => onParamValuesChange((prev) => ({
                                ...prev,
                                [def.type]: { ...prev[def.type], [p.name]: val },
                              }))}
                            />
                          </div>
                        );
                      }

                      return (
                        <div key={p.name} className="space-y-1">
                          <label className="text-xs font-medium text-foreground/80 flex items-center justify-between" title={p.description ?? p.name}>
                            <span>{p.label}{p.required && <span className="text-destructive ml-0.5">*</span>}</span>
                            {p.description && <span className="text-[10px] text-muted-foreground/60 font-normal">{p.description}</span>}
                          </label>

                          {p.multiselect && p.enum ? (
                            <div className="space-y-1.5">
                              {selectedArr.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {selectedArr.map((value, index) => (
                                    <Badge key={`${p.name}:${value}:${index}`} variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-violet-500/30 text-violet-300 bg-violet-500/5">
                                      {value}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                              <div className="flex flex-wrap gap-x-2.5 gap-y-1">
                                {p.enum.map((opt) => {
                                  const optStr = String(opt);
                                  const checked = selectedArr.includes(optStr);
                                  return (
                                    <label key={optStr} className="flex items-center gap-1.5 cursor-pointer text-xs text-foreground/80">
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => {
                                          onParamValuesChange((prev) => {
                                            const cur = Array.isArray(prev[def.type]?.[p.name]) ? [...(prev[def.type][p.name] as string[])] : [];
                                            const next = checked ? cur.filter((v) => v !== optStr) : [...cur, optStr];
                                            return { ...prev, [def.type]: { ...prev[def.type], [p.name]: next } };
                                          });
                                        }}
                                        className="accent-primary size-3 rounded"
                                      />
                                      {optStr}
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          ) : p.enum ? (
                            <select
                              value={typeof currentVal === "string" ? currentVal : ""}
                              onChange={(e) => onParamValuesChange((prev) => ({
                                ...prev,
                                [def.type]: { ...prev[def.type], [p.name]: e.target.value },
                              }))}
                              className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                            >
                              <option value="">—</option>
                              {p.enum.map((opt) => (
                                <option key={String(opt)} value={String(opt)}>{String(opt)}</option>
                              ))}
                            </select>
                          ) : p.type === "json" ? (
                            <textarea
                              rows={3}
                              placeholder={p.default !== undefined ? formatParamValue(p.default) : "{}"}
                              value={typeof currentVal === "string" ? currentVal : ""}
                              onChange={(e) => onParamValuesChange((prev) => ({
                                ...prev,
                                [def.type]: { ...prev[def.type], [p.name]: e.target.value },
                              }))}
                              className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                          ) : (
                            <input
                              type={p.type === "number" ? "number" : "text"}
                              placeholder={p.default !== undefined ? String(p.default) : undefined}
                              value={typeof currentVal === "string" ? currentVal : ""}
                              onChange={(e) => onParamValuesChange((prev) => ({
                                ...prev,
                                [def.type]: { ...prev[def.type], [p.name]: e.target.value },
                              }))}
                              className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                          )}
                        </div>
                      );
                    })}

                    {/* Delivery Filters */}
                    {(() => {
                      const schemaProps = (def.schema as any)?.properties ?? {};
                      const fields = Object.keys(schemaProps);
                      if (fields.length === 0) return null;
                      const currentMode = filterModeValues[def.type] ?? "and";

                      return (
                        <div className="pt-2 border-t border-border/40 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-blue-300 flex items-center gap-1.5">
                              <Filter className="size-3" /> Delivery Filters
                            </span>
                            {fields.length > 1 && (
                              <div className="flex items-center p-0.5 rounded-md bg-zinc-900 border border-border/60">
                                <button
                                  type="button"
                                  onClick={() => onFilterModeChange((prev) => ({ ...prev, [def.type]: "and" }))}
                                  className={cn(
                                    "text-[10px] font-semibold px-2 py-0.5 rounded transition-colors",
                                    currentMode === "and"
                                      ? "bg-blue-500/30 text-blue-200"
                                      : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  AND
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onFilterModeChange((prev) => ({ ...prev, [def.type]: "or" }))}
                                  className={cn(
                                    "text-[10px] font-semibold px-2 py-0.5 rounded transition-colors",
                                    currentMode === "or"
                                      ? "bg-blue-500/30 text-blue-200"
                                      : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  OR
                                </button>
                              </div>
                            )}
                          </div>

                          <div className="space-y-1.5">
                            {fields.map((field) => {
                              const propDef = schemaProps[field];
                              const enumVals = propDef?.enum as string[] | undefined;
                              const currentVal = filterValues[def.type]?.[field] ?? "";

                              return (
                                <div key={field} className="flex items-center gap-2">
                                  <label className="text-xs text-muted-foreground w-24 shrink-0 font-mono truncate">
                                    {field}
                                  </label>
                                  {enumVals ? (
                                    <select
                                      value={currentVal}
                                      onChange={(e) => onFilterValuesChange((prev) => ({
                                        ...prev,
                                        [def.type]: { ...prev[def.type], [field]: e.target.value },
                                      }))}
                                      className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                                    >
                                      <option value="">— any —</option>
                                      {enumVals.map((v) => (
                                        <option key={String(v)} value={String(v)}>{String(v)}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      type="text"
                                      placeholder={`filter by ${field}`}
                                      value={currentVal}
                                      onChange={(e) => onFilterValuesChange((prev) => ({
                                        ...prev,
                                        [def.type]: { ...prev[def.type], [field]: e.target.value },
                                      }))}
                                      className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}

                    {paramError && (
                      <p className="text-xs text-destructive bg-destructive/10 border border-destructive/30 px-2.5 py-1.5 rounded-md">
                        {paramError}
                      </p>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/40">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs px-2.5"
                        onClick={onParamFormClose}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 text-xs px-3 font-semibold bg-primary hover:bg-primary/90 text-primary-foreground"
                        disabled={isPendingToggle || (editMode && triggerSubscriptions.length === 0)}
                        onClick={() => onParamSubmit(def)}
                      >
                        {isPendingToggle ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
                        {editMode ? "Update" : "Subscribe"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Active Subscriptions Section ───────────────────────────────────────────

function ActiveSubscriptionsSection({ subscriptions }: { subscriptions: TriggerSubscription[] }) {
  const countsByType = subscriptions.reduce((map, sub) => {
    map.set(sub.triggerType, (map.get(sub.triggerType) ?? 0) + 1);
    return map;
  }, new Map<string, number>());

  if (subscriptions.length === 0) return null;

  return (
    <div className="p-3 space-y-2.5 border-t border-border/60">
      <div className="flex items-center gap-2">
        <span className="size-6 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
          <BellRing className="size-3.5" />
        </span>
        <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
          Active Subscriptions ({subscriptions.length})
        </span>
      </div>

      <div className="space-y-1.5">
        {subscriptions.map((sub, index) => (
          <div
            key={sub.subscriptionId ?? `${sub.triggerType}-${index}`}
            className="p-2.5 rounded-xl border border-zinc-800 bg-zinc-900/50 hover:border-zinc-700 transition-all flex items-center gap-2 flex-wrap"
          >
            <span className="text-xs font-mono font-medium text-foreground truncate flex-1">{sub.triggerType}</span>

            {sub.subscriptionId && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 font-mono border-emerald-500/30 text-emerald-400 bg-emerald-500/5">
                {truncateSubscriptionLabel(sub.subscriptionId, undefined, 18)}
              </Badge>
            )}

            {(countsByType.get(sub.triggerType) ?? 0) > 1 && !sub.subscriptionId && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-emerald-500/30 text-emerald-400">
                #{index + 1}
              </Badge>
            )}

            {sub.params && Object.keys(sub.params).length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                {Object.entries(sub.params).flatMap(([k, v]) => {
                  const badges = renderParamValueBadges(k, v, "px-1.5 py-0 text-[10px] h-4 border-emerald-500/30 text-emerald-400 bg-emerald-500/5 font-mono");
                  return Array.isArray(badges) ? badges : [badges];
                })}
              </div>
            )}

            {sub.filters && sub.filters.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-blue-500/30 text-blue-400 bg-blue-500/5">
                  {sub.filterMode === "or" ? "OR" : "AND"}
                </Badge>
                {sub.filters.map((f, i) => (
                  <Badge key={i} variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-blue-500/30 text-blue-400 bg-blue-500/5">
                    {f.field}{f.op === "contains" ? "~" : "="}{Array.isArray(f.value) ? f.value.map(String).join("|") : String(f.value)}
                  </Badge>
                ))}
              </div>
            )}

            <span className="text-[10px] text-muted-foreground/60 shrink-0 font-mono ml-auto">
              on {sub.runnerId.slice(0, 8)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Other Events Row ───────────────────────────────────────────────────────

function OtherTriggerRow({ entry }: { entry: TriggerHistoryEntry }) {
  const [expanded, setExpanded] = React.useState(false);
  const hasPayload = Object.keys(entry.payload).length > 0;
  const payloadStr = hasPayload ? JSON.stringify(entry.payload, null, 2) : null;

  return (
    <div className="border-b border-border/40 last:border-0 hover:bg-white/[0.015] transition-colors">
      <button
        type="button"
        onClick={() => hasPayload && setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors",
          hasPayload ? "hover:bg-muted/40 cursor-pointer" : "cursor-default",
        )}
      >
        <div className="shrink-0">
          {entry.direction === "inbound" ? (
            <ArrowDownCircle className="size-3.5 text-blue-400" />
          ) : (
            <ArrowUpCircle className="size-3.5 text-violet-400" />
          )}
        </div>

        <div className="shrink-0 text-muted-foreground">
          <SourceIcon source={entry.source} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-semibold text-foreground truncate">{entry.type}</span>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4">
              {sourceLabel(entry.source)}
            </Badge>
            {entry.deliverAs === "steer" ? (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-amber-500/40 text-amber-400 bg-amber-500/5">
                steer
              </Badge>
            ) : (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-blue-500/40 text-blue-400 bg-blue-500/5">
                follow-up
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px]">
            <span className="text-[10px] text-muted-foreground/70 font-mono"><RelativeTime isoTs={entry.ts} /></span>
            {entry.response && (
              <span className="text-[10px] text-emerald-400 font-medium">
                ✓ {entry.response.action ?? "responded"}
              </span>
            )}
            {entry.summary && (
              <span className="text-[11px] text-muted-foreground/70 truncate">{entry.summary}</span>
            )}
          </div>
        </div>

        {hasPayload && (
          <div className="shrink-0 text-muted-foreground/50">
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </div>
        )}
      </button>

      {expanded && payloadStr && (
        <div className="px-3 pb-2.5 pt-0.5">
          <pre className="rounded-lg bg-zinc-950/80 border border-border/60 p-2.5 text-[10px] font-mono text-zinc-300 overflow-auto max-h-40 whitespace-pre-wrap break-all leading-relaxed shadow-inner">
            {payloadStr}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Source Accordion (unified accordion for any source) ────────────────────

interface SourceAccordionProps {
  group: SourceGroup;
  statusUpdates: Map<string, TriggerStatusUpdate>;
}

function SourceAccordion({ group, statusUpdates }: SourceAccordionProps) {
  const [expanded, setExpanded] = React.useState(false);
  const isPending = !!group.pendingTrigger;

  // Derive status for linked sessions
  const status = group.isLinkedSession
    ? deriveSessionStatus({
        source: group.source,
        events: group.events,
        pendingTrigger: group.pendingTrigger,
        lastType: group.events[0]?.type ?? "",
        lastTs: group.lastTs,
        lastSummary: group.lastSummary,
      })
    : null;

  // Find the most recent status update for any trigger in this group
  const latestStatusUpdate = React.useMemo(() => {
    let latest: TriggerStatusUpdate | null = null;
    for (const event of group.events) {
      const update = statusUpdates.get(event.triggerId);
      if (update && (!latest || new Date(update.ts) > new Date(latest.ts))) {
        latest = update;
      }
    }
    return latest;
  }, [group.events, statusUpdates]);

  const colorMap = {
    amber: { border: "border-amber-500/40", bg: "bg-gradient-to-b from-amber-500/[0.08] to-zinc-900/30", badge: "border-amber-500/40 bg-amber-500/10 text-amber-400", icon: "text-amber-400", pulse: true },
    blue: { border: "border-blue-500/40", bg: "bg-gradient-to-b from-blue-500/[0.08] to-zinc-900/30", badge: "border-blue-500/40 bg-blue-500/10 text-blue-400", icon: "text-blue-400", pulse: true },
    red: { border: "border-red-500/40", bg: "bg-gradient-to-b from-red-500/[0.08] to-zinc-900/30", badge: "border-red-500/40 bg-red-500/10 text-red-400", icon: "text-red-400", pulse: true },
    emerald: { border: "border-emerald-500/30", bg: "bg-zinc-900/40", badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400", icon: "text-emerald-400", pulse: false },
    zinc: { border: "border-border/60", bg: "bg-zinc-900/30", badge: "border-border/80 bg-muted/40 text-muted-foreground", icon: "text-muted-foreground", pulse: false },
  };

  const colors = status ? colorMap[status.color] : { border: "border-border/60", bg: "bg-zinc-900/30", badge: "border-border/80 bg-muted/40 text-muted-foreground", icon: "text-muted-foreground", pulse: false };

  return (
    <div className={cn("rounded-xl border overflow-hidden shadow-sm transition-all relative", colors.border, colors.bg)}>
      {isPending && (
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent" />
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-3 p-3 text-left transition-colors hover:bg-white/[0.02]"
      >
        {/* Icon */}
        <div className={cn("size-7 rounded-lg border border-border/40 bg-muted/30 flex items-center justify-center shrink-0 mt-0.5 shadow-sm", colors.icon, colors.pulse && "animate-pulse")}>
          {status ? status.icon : <SourceIcon source={group.source} />}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Name + status badge */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-foreground truncate">
              {group.lastSummary || group.label || truncateId(group.source)}
            </span>
            {status && (
              <Badge variant="outline" className={cn("px-2 py-0.5 text-[10px] font-medium rounded-md shrink-0 capitalize", colors.badge)}>
                {status.label}
              </Badge>
            )}
          </div>

          {/* Pending trigger detail */}
          {isPending && group.isLinkedSession && (
            <div className="mt-1.5 p-2 rounded-lg bg-zinc-950/60 border border-border/50 space-y-1">
              <div className="flex items-center justify-between">
                <span className={cn("text-xs font-medium", status ? `text-${status.color}-300` : "text-amber-300")}>
                  {group.pendingTrigger!.type === "ask_user_question" && "Waiting for your answer"}
                  {group.pendingTrigger!.type === "plan_review" && "Waiting for plan approval"}
                  {group.pendingTrigger!.type === "session_complete" && "Session finished — needs acknowledgement"}
                  {group.pendingTrigger!.type === "escalate" && "Escalated — needs human attention"}
                  {!["ask_user_question", "plan_review", "session_complete", "escalate"].includes(group.pendingTrigger!.type) && `Awaiting response to ${group.pendingTrigger!.type}`}
                </span>
                <span className="text-[10px] text-muted-foreground/70 font-mono ml-2">
                  <RelativeTime isoTs={group.pendingTrigger!.ts} />
                </span>
              </div>
            </div>
          )}

          {/* Streaming status update */}
          {latestStatusUpdate && (
            <div className="mt-1.5 flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-blue-950/30 border border-blue-500/20">
              <Loader2 className="size-3 animate-spin text-blue-400 shrink-0" />
              <span className="text-[11px] text-blue-200/90 font-medium truncate">
                {latestStatusUpdate.statusText}
              </span>
            </div>
          )}

          {/* Last event + time */}
          {!isPending && !latestStatusUpdate && (
            <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground/70">
              <span>
                Last: <span className="font-mono text-foreground/80">{group.events[0]?.type}</span>
              </span>
              <span>·</span>
              <span className="font-mono text-muted-foreground/50">
                <RelativeTime isoTs={group.lastTs} />
              </span>
            </div>
          )}

          {/* Event count + source ID hint */}
          <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground/50">
            <span className="font-medium bg-muted/40 px-1.5 py-0.5 rounded border border-border/40">
              {group.events.length} event{group.events.length !== 1 ? "s" : ""}
            </span>
            {group.lastSummary && group.isLinkedSession && (
              <span className="font-mono text-muted-foreground/40 truncate">
                #{truncateId(group.source)}
              </span>
            )}
          </div>
        </div>

        {/* Expand chevron */}
        <div className="mt-0.5 shrink-0 text-muted-foreground/40 p-1 hover:text-foreground">
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </div>
      </button>

      {/* Expanded event history */}
      {expanded && (
        <div className={cn("border-t bg-zinc-950/40 divide-y divide-border/30", colors.border)}>
          {group.events.map((event) => (
            <EventRow key={event.triggerId} entry={event} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────────

export interface TriggersPanelProps {
  sessionId: string;
  triggerDefs?: ServiceTriggerDef[];
  /** Viewer socket — used to listen for real-time events. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewerSocket?: any;
}

export function TriggersPanel({ sessionId, triggerDefs = [], viewerSocket }: TriggersPanelProps) {
  const [triggers, setTriggers] = React.useState<TriggerHistoryEntry[]>([]);
  const [subscriptions, setSubscriptions] = React.useState<TriggerSubscription[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [sendOpen, setSendOpen] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  // Ephemeral status updates keyed by triggerId
  const [statusUpdates, setStatusUpdates] = React.useState<Map<string, TriggerStatusUpdate>>(new Map());

  const fetchSubscriptions = React.useCallback(async () => {
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/trigger-subscriptions`,
        { credentials: "include" },
      );
      if (res.ok) {
        const data = await res.json() as { subscriptions: TriggerSubscription[] };
        setSubscriptions(data.subscriptions ?? []);
      }
    } catch {
      // best-effort
    }
  }, [sessionId]);

  const fetchTriggers = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);

    try {
      const [triggersRes] = await Promise.all([
        fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/triggers?limit=50`,
          { credentials: "include" },
        ),
        fetchSubscriptions(),
      ]);
      if (!triggersRes.ok) {
        throw new Error(`HTTP ${triggersRes.status}`);
      }
      const data = await triggersRes.json() as { triggers: TriggerHistoryEntry[] };
      setTriggers(data.triggers ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load triggers");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sessionId, fetchSubscriptions]);

  // Initial fetch
  React.useEffect(() => {
    void fetchTriggers(false);
  }, [fetchTriggers]);

  // Auto-refresh every 10s
  React.useEffect(() => {
    const timer = setInterval(() => { void fetchTriggers(true); }, 10_000);
    return () => clearInterval(timer);
  }, [fetchTriggers]);

  // Instant refresh on trigger_delivered event
  React.useEffect(() => {
    if (!viewerSocket) return;
    const handler = () => { void fetchTriggers(true); };
    viewerSocket.on("trigger_delivered", handler);
    return () => { viewerSocket.off("trigger_delivered", handler); };
  }, [viewerSocket, fetchTriggers]);

  // Listen for trigger_status_update events
  React.useEffect(() => {
    if (!viewerSocket) return;
    const handler = (data: TriggerStatusUpdate) => {
      if (!data?.triggerId || !data?.statusText) return;
      setStatusUpdates((prev) => {
        const next = new Map(prev);
        next.set(data.triggerId, data);
        return next;
      });
    };
    viewerSocket.on("trigger_status_update", handler);
    return () => { viewerSocket.off("trigger_status_update", handler); };
  }, [viewerSocket]);

  // Derive grouped layout — all triggers grouped by source
  const sourceGroups = React.useMemo(
    () => groupTriggersBySource(triggers),
    [triggers],
  );

  // Legacy grouping still needed for getIncompleteTriggers and pending count
  const { sessionGroups } = React.useMemo(
    () => groupByLinkedSession(triggers),
    [triggers],
  );
  const pendingGroups = sessionGroups.filter((g) => g.pendingTrigger);

  const handleRefresh = React.useCallback(() => {
    void fetchTriggers(true);
  }, [fetchTriggers]);

  // Tab state: "history" or "catalog"
  const hasCatalog = triggerDefs.length > 0 || subscriptions.length > 0;
  const userSelectedTabRef = React.useRef(false);
  const [activeTab, setActiveTab] = React.useState<"history" | "catalog">("history");

  // Auto-switch to catalog when history is empty and catalog is available,
  // but only if the user hasn't manually selected a tab yet.
  React.useEffect(() => {
    if (!userSelectedTabRef.current && triggers.length === 0 && hasCatalog) {
      setActiveTab("catalog");
    }
  }, [triggers.length, hasCatalog]);

  // Filter state for history tab
  const [historyFilter, setHistoryFilter] = React.useState<"all" | "pending" | "sessions" | "services">("all");

  const filteredSourceGroups = React.useMemo(() => {
    if (historyFilter === "pending") {
      return sourceGroups.filter((g) => !!g.pendingTrigger);
    }
    if (historyFilter === "sessions") {
      return sourceGroups.filter((g) => g.isLinkedSession);
    }
    if (historyFilter === "services") {
      return sourceGroups.filter((g) => !g.isLinkedSession);
    }
    return sourceGroups;
  }, [sourceGroups, historyFilter]);

  const pendingCount = pendingGroups.length;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* Modern Toolbar with Segmented Tab Control & Action Buttons */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/80 bg-zinc-950/60 backdrop-blur-md shrink-0 gap-2">
        {/* Segmented Tabs */}
        <div className="flex items-center p-0.5 rounded-lg bg-zinc-900 border border-border/60">
          <button
            type="button"
            onClick={() => { userSelectedTabRef.current = true; setActiveTab("history"); }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md transition-all",
              activeTab === "history"
                ? "bg-zinc-800 text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Clock className="size-3 text-blue-400" />
            <span>History</span>
            {pendingCount > 0 && (
              <span className="inline-flex items-center justify-center px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-bold">
                {pendingCount}
              </span>
            )}
          </button>

          {hasCatalog && (
            <button
              type="button"
              onClick={() => { userSelectedTabRef.current = true; setActiveTab("catalog"); }}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md transition-all",
                activeTab === "catalog"
                  ? "bg-zinc-800 text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <BookOpen className="size-3 text-emerald-400" />
              <span>Catalog</span>
              {subscriptions.length > 0 && (
                <span className="inline-flex items-center justify-center px-1.5 py-0.2 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold">
                  {subscriptions.length}
                </span>
              )}
            </button>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="size-7 rounded-lg border border-border/80 bg-zinc-900/60 text-muted-foreground hover:text-foreground hover:bg-zinc-800 hover:border-border flex items-center justify-center transition-all disabled:opacity-50"
            title="Refresh"
            aria-label="Refresh trigger history"
          >
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          </button>

          <Button
            size="sm"
            className="h-7 text-xs px-2.5 gap-1.5 font-semibold bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm shadow-primary/20 rounded-lg transition-all"
            onClick={() => setSendOpen(true)}
          >
            <Send className="size-3" />
            <span>Send</span>
          </Button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
        {/* ─── History tab ─── */}
        {activeTab === "history" && (
          <>
            {loading ? (
              <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
                <Loader2 className="size-5 animate-spin text-primary" />
                <span className="text-xs font-medium">Loading triggers…</span>
              </div>
            ) : error ? (
              <div className="flex items-center justify-center p-6">
                <p className="text-xs text-destructive text-center bg-destructive/10 border border-destructive/20 p-3 rounded-lg">{error}</p>
              </div>
            ) : triggers.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 p-8 text-center my-auto">
                <div className="size-12 rounded-2xl bg-zinc-900 border border-border/80 flex items-center justify-center text-muted-foreground/40 shadow-inner">
                  <Zap className="size-6" />
                </div>
                <div className="space-y-1 max-w-[240px]">
                  <p className="text-xs font-semibold text-foreground">No triggers yet</p>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    No triggers yet. External systems can send triggers via the API.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5 p-3">
                {/* Source Filter Chips when multiple sources exist */}
                {sourceGroups.length > 2 && (
                  <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-[11px]">
                    <span className="text-[10px] font-semibold uppercase text-muted-foreground tracking-wider mr-1">Filter:</span>
                    <button
                      type="button"
                      onClick={() => setHistoryFilter("all")}
                      className={cn(
                        "px-2 py-0.5 rounded-md font-medium border transition-colors",
                        historyFilter === "all"
                          ? "bg-zinc-800 border-zinc-700 text-foreground"
                          : "bg-muted/20 border-border/40 text-muted-foreground hover:bg-muted/40",
                      )}
                    >
                      All ({sourceGroups.length})
                    </button>
                    {pendingCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setHistoryFilter("pending")}
                        className={cn(
                          "px-2 py-0.5 rounded-md font-medium border transition-colors flex items-center gap-1",
                          historyFilter === "pending"
                            ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                            : "bg-muted/20 border-border/40 text-amber-400/80 hover:bg-amber-500/10",
                        )}
                      >
                        <span className="size-1.5 rounded-full bg-amber-400"></span>
                        Pending ({pendingCount})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setHistoryFilter("sessions")}
                      className={cn(
                        "px-2 py-0.5 rounded-md font-medium border transition-colors",
                        historyFilter === "sessions"
                          ? "bg-zinc-800 border-zinc-700 text-foreground"
                          : "bg-muted/20 border-border/40 text-muted-foreground hover:bg-muted/40",
                      )}
                    >
                      Sessions
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistoryFilter("services")}
                      className={cn(
                        "px-2 py-0.5 rounded-md font-medium border transition-colors",
                        historyFilter === "services"
                          ? "bg-zinc-800 border-zinc-700 text-foreground"
                          : "bg-muted/20 border-border/40 text-muted-foreground hover:bg-muted/40",
                      )}
                    >
                      Services
                    </button>
                  </div>
                )}

                {filteredSourceGroups.map((group) => (
                  <SourceAccordion
                    key={group.source}
                    group={group}
                    statusUpdates={statusUpdates}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ─── Catalog tab ─── */}
        {activeTab === "catalog" && (
          <>
            {/* Trigger catalog */}
            {triggerDefs.length > 0 && (
              <TriggerCatalogSection
                sessionId={sessionId}
                triggerDefs={triggerDefs}
                subscriptions={subscriptions}
                onSubscriptionsChange={fetchSubscriptions}
              />
            )}

            {/* Active subscriptions */}
            {subscriptions.length > 0 && (
              <ActiveSubscriptionsSection subscriptions={subscriptions} />
            )}

            {triggerDefs.length === 0 && subscriptions.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 p-8 text-center my-auto">
                <div className="size-12 rounded-2xl bg-zinc-900 border border-border/80 flex items-center justify-center text-muted-foreground/40 shadow-inner">
                  <BookOpen className="size-6" />
                </div>
                <div className="space-y-1 max-w-[260px]">
                  <p className="text-xs font-semibold text-foreground">No trigger types available</p>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Runner services can declare triggers for agents and workflows to subscribe to.
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Send Trigger Dialog */}
      <SendTriggerDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        sessionId={sessionId}
        triggerDefs={triggerDefs}
        onSent={() => { void fetchTriggers(true); }}
      />
    </div>
  );
}

// ── Cron schedule builder ───────────────────────────────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DEFAULT_SCHEDULE: RecurringSchedule = { freq: "daily", hour: 9, minute: 0, day: 1 };

const cronInputCls = "rounded-lg border border-border bg-background px-2.5 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary";

/**
 * Friendly Daily/Weekly/Monthly builder for cron params. The user picks a
 * local time; the stored param value is the equivalent UTC cron expression
 * (the runner evaluates cron in UTC). Unrepresentable expressions (steps,
 * ranges, lists) fall back to a raw "Custom" input.
 */
function CronScheduleBuilder({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const parsed = React.useMemo(() => scheduleFromCron(value), [value]);
  const [customMode, setCustomMode] = React.useState(() => value.trim() !== "" && !parsed);

  React.useEffect(() => {
    if (!customMode && value.trim() === "") onChange(cronFromSchedule(DEFAULT_SCHEDULE));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sched = parsed ?? DEFAULT_SCHEDULE;
  const set = (patch: Partial<RecurringSchedule>) => onChange(cronFromSchedule({ ...sched, ...patch }));

  return (
    <div className="flex-1 space-y-2 p-3 rounded-xl border border-border/80 bg-zinc-900/50">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={customMode ? "custom" : sched.freq}
          onChange={(e) => {
            if (e.target.value === "custom") {
              setCustomMode(true);
            } else {
              setCustomMode(false);
              set({ freq: e.target.value as RecurringSchedule["freq"] });
            }
          }}
          className={cronInputCls}
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="custom">Custom (raw cron)</option>
        </select>

        {!customMode && sched.freq === "weekly" && (
          <select
            value={sched.day ?? 1}
            onChange={(e) => set({ day: Number(e.target.value) })}
            className={cronInputCls}
          >
            {WEEKDAYS.map((name, idx) => (
              <option key={name} value={idx}>{name}</option>
            ))}
          </select>
        )}

        {!customMode && sched.freq === "monthly" && (
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-muted-foreground">Day</span>
            <input
              type="number"
              min={1}
              max={31}
              value={sched.day ?? 1}
              onChange={(e) => set({ day: Math.max(1, Math.min(31, Number(e.target.value))) })}
              className={cn(cronInputCls, "w-14")}
            />
          </div>
        )}

        {!customMode && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">at</span>
            <input
              type="time"
              value={`${String(sched.hour).padStart(2, "0")}:${String(sched.minute).padStart(2, "0")}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (!isNaN(h) && !isNaN(m)) set({ hour: h, minute: m });
              }}
              className={cronInputCls}
            />
          </div>
        )}
      </div>

      {customMode ? (
        <div className="space-y-1">
          <input
            type="text"
            placeholder="* * * * * (minute hour dom month dow)"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={cn(cronInputCls, "w-full font-mono")}
          />
          <p className="text-[10px] text-muted-foreground/60">
            5-field cron expression evaluated in UTC.
          </p>
        </div>
      ) : (
        <p className="text-[11px] font-mono text-muted-foreground/60">
          UTC: <span className="text-foreground/80">{cronFromSchedule(sched)}</span>
        </p>
      )}
    </div>
  );
}
