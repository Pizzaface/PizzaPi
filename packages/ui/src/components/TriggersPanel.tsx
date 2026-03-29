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
  BellRing,
  BellOff,
  BookOpen,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  XCircle,
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
import type { ServiceTriggerDef, ServiceTriggerParamDef } from "@pizzapi/protocol";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TriggerHistoryEntry {
  triggerId: string;
  type: string;
  source: string;
  summary?: string;
  payload: Record<string, unknown>;
  deliverAs: "steer" | "followUp";
  ts: string;
  direction: "inbound" | "outbound";
  response?: {
    action?: string;
    text?: string;
    ts: string;
  };
}

export interface TriggerSubscription {
  triggerType: string;
  runnerId: string;
  params?: Record<string, string | number | boolean | Array<string | number | boolean>>;
}

/** Ephemeral status update for a trigger (not persisted in history). */
interface TriggerStatusUpdate {
  triggerId: string;
  sourceSessionId: string;
  statusText: string;
  ts: string;
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

function formatRelativeTime(isoTs: string): string {
  const now = Date.now();
  const then = new Date(isoTs).getTime();
  if (isNaN(then)) return isoTs;
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

/** Returns a lucide icon for the trigger source */
function SourceIcon({ source, className }: { source: string; className?: string }) {
  const src = source.toLowerCase();
  if (src.includes("webhook") || src.includes("http")) return <Globe className={cn("size-3.5", className)} />;
  if (src.includes("cron") || src.includes("schedule")) return <Clock className={cn("size-3.5", className)} />;
  if (src.includes("service")) return <Settings className={cn("size-3.5", className)} />;
  if (src === "api" || src.startsWith("external")) return <Globe className={cn("size-3.5", className)} />;
  if (src.length >= 8 && /^[a-z0-9-]+$/.test(src)) return <Link className={cn("size-3.5", className)} />;
  return <Wrench className={cn("size-3.5", className)} />;
}

function sourceLabel(source: string): string {
  if (!source || source === "api") return "API";
  if (source.startsWith("external:")) return source.slice(9);
  return source;
}

/** Truncate a session ID for display. */
function truncateId(id: string, maxLen = 12): string {
  if (id.length <= maxLen) return id;
  return id.slice(0, maxLen) + "…";
}

/** Known trigger types that require a response (interactive triggers). */
export const RESPONSE_TRIGGER_TYPES = new Set([
  "ask_user_question",
  "plan_review",
  "escalate",
]);

/** Whether a trigger is "pending" — inbound, requires response, and has none. */
export function isPendingTrigger(entry: TriggerHistoryEntry): boolean {
  if (entry.direction !== "inbound") return false;
  if (entry.response) return false;
  return RESPONSE_TRIGGER_TYPES.has(entry.type);
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
 * - A linked session that is still active (no session_complete yet)
 *
 * Sessions that have sent session_complete are considered done regardless of
 * whether the parent has formally ack'd — the child finished its work.
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

    // Any session_complete event (ack'd or not) means the child finished
    const hasCompleted = group.events.some(e => e.type === "session_complete");
    if (hasCompleted) continue;

    // Still active (connected, no session_complete)
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="size-4 text-amber-400" />
            Send Trigger
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Type <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              {...(triggerDefs && triggerDefs.length > 0 ? { list: "trigger-type-suggestions" } : {})}
              placeholder="e.g. webhook, custom_event"
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value)}
              className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {triggerDefs && triggerDefs.length > 0 && (
              <datalist id="trigger-type-suggestions">
                {triggerDefs.map((def) => (
                  <option key={def.type} value={def.type}>{def.label}</option>
                ))}
              </datalist>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Source <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <input
              type="text"
              placeholder="e.g. github, godmother"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Payload (JSON)
            </label>
            <textarea
              rows={4}
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              className="w-full rounded border border-border bg-background px-2.5 py-1.5 font-mono text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
              spellCheck={false}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Deliver As
            </label>
            <div className="flex gap-3">
              {(["steer", "followUp"] as const).map((mode) => (
                <label key={mode} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="deliverAs"
                    value={mode}
                    checked={deliverAs === mode}
                    onChange={() => setDeliverAs(mode)}
                    className="accent-primary"
                  />
                  <span className="text-sm capitalize">{mode === "steer" ? "Steer (interrupt)" : "Follow-Up (queue)"}</span>
                </label>
              ))}
            </div>
          </div>

          {error && (
            <p className="rounded bg-destructive/10 border border-destructive/30 px-2.5 py-1.5 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={sending || !triggerType.trim()}>
            {sending ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <Send className="size-3.5 mr-1.5" />}
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
  const hasPayload = Object.keys(entry.payload).length > 0;
  const payloadStr = hasPayload ? JSON.stringify(entry.payload, null, 2) : null;

  return (
    <div className="border-b border-border/30 last:border-0">
      <button
        type="button"
        onClick={() => hasPayload && setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
          hasPayload ? "hover:bg-muted/40 cursor-pointer" : "cursor-default",
        )}
      >
        <div className="shrink-0">
          {entry.direction === "inbound" ? (
            <ArrowDownCircle className="size-3 text-blue-400/70" />
          ) : (
            <ArrowUpCircle className="size-3 text-violet-400/70" />
          )}
        </div>

        <span className="text-[11px] font-medium text-foreground/80">{entry.type}</span>

        {entry.deliverAs === "steer" ? (
          <Badge variant="outline" className="px-1 py-0 text-[9px] h-3.5 border-amber-500/30 text-amber-400/70">
            steer
          </Badge>
        ) : (
          <Badge variant="outline" className="px-1 py-0 text-[9px] h-3.5 border-blue-500/30 text-blue-400/70">
            follow-up
          </Badge>
        )}

        <span className="text-[10px] text-muted-foreground/50 ml-auto shrink-0">
          {formatRelativeTime(entry.ts)}
        </span>

        {entry.response && (
          <span className="text-[10px] text-emerald-500/70 shrink-0">
            ✓ {entry.response.action ?? "responded"}
          </span>
        )}

        {hasPayload && (
          <div className="shrink-0 text-muted-foreground/40">
            {expanded ? <ChevronDown className="size-2.5" /> : <ChevronRight className="size-2.5" />}
          </div>
        )}
      </button>

      {expanded && payloadStr && (
        <div className="px-3 pb-1.5">
          <pre className="rounded bg-muted/60 border border-border/50 px-2 py-1.5 text-[9px] font-mono text-foreground/70 overflow-auto max-h-32 whitespace-pre-wrap break-all">
            {payloadStr}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Linked Session Card ────────────────────────────────────────────────────

interface LinkedSessionCardProps {
  group: LinkedSessionGroup;
  statusUpdates: Map<string, TriggerStatusUpdate>;
  /** Force relative times to re-render */
  tick: number;
}

function LinkedSessionCard({ group, statusUpdates, tick: _tick }: LinkedSessionCardProps) {
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
      border: "border-amber-500/30",
      bg: "bg-amber-950/20",
      headerBg: "bg-amber-950/30",
      text: "text-amber-300",
      badge: "border-amber-500/40 text-amber-400",
      icon: "text-amber-400",
      pulse: true,
    },
    blue: {
      border: "border-blue-500/30",
      bg: "bg-blue-950/20",
      headerBg: "bg-blue-950/30",
      text: "text-blue-300",
      badge: "border-blue-500/40 text-blue-400",
      icon: "text-blue-400",
      pulse: true,
    },
    red: {
      border: "border-red-500/30",
      bg: "bg-red-950/20",
      headerBg: "bg-red-950/30",
      text: "text-red-300",
      badge: "border-red-500/40 text-red-400",
      icon: "text-red-400",
      pulse: true,
    },
    emerald: {
      border: "border-emerald-500/20",
      bg: "bg-emerald-950/10",
      headerBg: "bg-emerald-950/20",
      text: "text-emerald-300",
      badge: "border-emerald-500/40 text-emerald-400",
      icon: "text-emerald-400",
      pulse: false,
    },
    zinc: {
      border: "border-border/50",
      bg: "bg-muted/10",
      headerBg: "bg-muted/20",
      text: "text-muted-foreground",
      badge: "border-border text-muted-foreground",
      icon: "text-muted-foreground",
      pulse: false,
    },
  };

  const colors = colorMap[status.color];

  return (
    <div className={cn("rounded-lg border overflow-hidden", colors.border, colors.bg)}>
      {/* Main clickable header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.02]",
        )}
      >
        {/* Status icon */}
        <div className={cn("mt-0.5 shrink-0", colors.icon, colors.pulse && "animate-pulse")}>
          {status.icon}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Session name + status */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-mono text-foreground/90 truncate">
              {group.lastSummary || truncateId(group.source)}
            </span>
            <Badge
              variant="outline"
              className={cn("px-1.5 py-0 text-[10px] h-4 shrink-0", colors.badge)}
            >
              {status.label}
            </Badge>
          </div>

          {/* Pending trigger detail */}
          {isPending && (
            <div className="mt-1">
              <span className={cn("text-[11px] font-medium", colors.text)}>
                {group.pendingTrigger!.type === "ask_user_question" && "Waiting for your answer"}
                {group.pendingTrigger!.type === "plan_review" && "Waiting for plan approval"}
                {group.pendingTrigger!.type === "session_complete" && "Session finished — needs acknowledgement"}
                {group.pendingTrigger!.type === "escalate" && "Escalated — needs human attention"}
                {!["ask_user_question", "plan_review", "session_complete", "escalate"].includes(group.pendingTrigger!.type) && `Awaiting response to ${group.pendingTrigger!.type}`}
              </span>
              <span className="text-[10px] text-muted-foreground/60 ml-2">
                {formatRelativeTime(group.pendingTrigger!.ts)}
              </span>
            </div>
          )}

          {/* Streaming status update */}
          {latestStatusUpdate && (
            <div className="mt-1 flex items-center gap-1.5">
              <Loader2 className="size-2.5 animate-spin text-muted-foreground/60 shrink-0" />
              <span className="text-[10px] text-muted-foreground/80 italic truncate">
                {latestStatusUpdate.statusText}
              </span>
            </div>
          )}

          {/* Non-pending: show last event summary */}
          {!isPending && !latestStatusUpdate && (
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground/60">
                Last: <span className="text-muted-foreground/80">{group.lastType}</span>
              </span>
              <span className="text-[10px] text-muted-foreground/40">
                {formatRelativeTime(group.lastTs)}
              </span>
            </div>
          )}

          {/* Event count + session ID hint */}
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground/40">
              {group.events.length} event{group.events.length !== 1 ? "s" : ""}
            </span>
            {group.lastSummary && (
              <span className="text-[10px] font-mono text-muted-foreground/30 truncate">
                {truncateId(group.source)}
              </span>
            )}
          </div>
        </div>

        {/* Expand chevron */}
        <div className="mt-0.5 shrink-0 text-muted-foreground/40">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </div>
      </button>

      {/* Expanded event history */}
      {expanded && (
        <div className={cn("border-t", colors.border)}>
          {group.events.map((event) => (
            <EventRow key={event.triggerId} entry={event} />
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
  // Track which trigger type has its param form open
  const [paramFormOpen, setParamFormOpen] = React.useState<string | null>(null);
  // Track param form values keyed by trigger type (string for scalar, string[] for multiselect)
  const [paramValues, setParamValues] = React.useState<Record<string, Record<string, string | string[]>>>({});
  const [paramError, setParamError] = React.useState<string | null>(null);

  const subscribedTypes = React.useMemo(
    () => new Set(subscriptions.map((s) => s.triggerType)),
    [subscriptions],
  );

  const subscriptionMap = React.useMemo(
    () => new Map(subscriptions.map((s) => [s.triggerType, s])),
    [subscriptions],
  );

  const handleUnsubscribe = React.useCallback(async (triggerType: string) => {
    setPending((prev) => new Set([...prev, triggerType]));
    try {
      await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/trigger-subscriptions/${encodeURIComponent(triggerType)}`,
        { method: "DELETE", credentials: "include" },
      );
      onSubscriptionsChange();
    } catch {
      // ignore
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(triggerType);
        return next;
      });
    }
  }, [sessionId, onSubscriptionsChange]);

  const handleSubscribe = React.useCallback(async (triggerType: string, params?: Record<string, unknown>) => {
    setPending((prev) => new Set([...prev, triggerType]));
    setParamError(null);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/trigger-subscriptions`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ triggerType, ...(params ? { params } : {}) }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setParamError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setParamFormOpen(null);
      onSubscriptionsChange();
    } catch {
      // ignore
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(triggerType);
        return next;
      });
    }
  }, [sessionId, onSubscriptionsChange]);

  const handleToggle = React.useCallback((def: ServiceTriggerDef, isSubscribed: boolean) => {
    if (isSubscribed) {
      handleUnsubscribe(def.type);
    } else if (def.params && def.params.length > 0) {
      // Open param form instead of subscribing directly
      setParamFormOpen(def.type);
      setParamError(null);
      // Pre-fill with defaults
      const defaults: Record<string, string | string[]> = {};
      for (const p of def.params) {
        if (p.multiselect) {
          // Multiselect defaults to empty array (user picks)
          defaults[p.name] = defaults[p.name] ?? [];
        } else if (p.default !== undefined) {
          defaults[p.name] = String(p.default);
        }
      }
      setParamValues((prev) => ({ ...prev, [def.type]: { ...defaults, ...prev[def.type] } }));
    } else {
      handleSubscribe(def.type);
    }
  }, [handleUnsubscribe, handleSubscribe]);

  const handleParamSubmit = React.useCallback((def: ServiceTriggerDef) => {
    const vals = paramValues[def.type] ?? {};
    const params: Record<string, unknown> = {};
    for (const p of (def.params ?? [])) {
      const raw = vals[p.name];

      // Multiselect: value is string[]
      if (p.multiselect && p.enum) {
        const selected = Array.isArray(raw) ? raw : [];
        if (selected.length === 0 && p.required) {
          setParamError(`'${p.label}' requires at least one selection`);
          return;
        }
        if (selected.length === 0) continue;
        // Coerce array items to the declared type
        if (p.type === "number") {
          params[p.name] = selected.map(Number).filter(n => !isNaN(n));
        } else if (p.type === "boolean") {
          params[p.name] = selected.map(v => v === "true");
        } else {
          params[p.name] = selected;
        }
        continue;
      }

      // Scalar
      const str = (typeof raw === "string" ? raw : "").trim();
      if (!str && p.required) {
        setParamError(`'${p.label}' is required`);
        return;
      }
      if (!str) continue;
      if (p.type === "number") {
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
    handleSubscribe(def.type, Object.keys(params).length > 0 ? params : undefined);
  }, [paramValues, handleSubscribe]);

  // Group trigger defs by service prefix (part before ':')
  const serviceGroups = React.useMemo(() => {
    const map = new Map<string, ServiceTriggerDef[]>();
    for (const def of triggerDefs) {
      const colonIdx = def.type.indexOf(":");
      const service = colonIdx > 0 ? def.type.slice(0, colonIdx) : def.type;
      const existing = map.get(service);
      if (existing) {
        existing.push(def);
      } else {
        map.set(service, [def]);
      }
    }
    return Array.from(map.entries()).map(([service, defs]) => ({
      service,
      defs,
      subscribedCount: defs.filter((d) => subscribedTypes.has(d.type)).length,
    }));
  }, [triggerDefs, subscribedTypes]);

  if (triggerDefs.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 p-2">
      {serviceGroups.map(({ service, defs, subscribedCount }) => (
        <ServiceCatalogAccordion
          key={service}
          service={service}
          defs={defs}
          subscribedCount={subscribedCount}
          subscribedTypes={subscribedTypes}
          subscriptionMap={subscriptionMap}
          pending={pending}
          paramFormOpen={paramFormOpen}
          paramValues={paramValues}
          paramError={paramError}
          onToggle={handleToggle}
          onParamSubmit={handleParamSubmit}
          onParamFormOpen={setParamFormOpen}
          onParamFormClose={() => { setParamFormOpen(null); setParamError(null); }}
          onParamValuesChange={setParamValues}
        />
      ))}
    </div>
  );
}

// ── Service Catalog Accordion (one per service prefix) ─────────────────────

interface ServiceCatalogAccordionProps {
  service: string;
  defs: ServiceTriggerDef[];
  subscribedCount: number;
  subscribedTypes: Set<string>;
  subscriptionMap: Map<string, TriggerSubscription>;
  pending: Set<string>;
  paramFormOpen: string | null;
  paramValues: Record<string, Record<string, string | string[]>>;
  paramError: string | null;
  onToggle: (def: ServiceTriggerDef, isSubscribed: boolean) => void;
  onParamSubmit: (def: ServiceTriggerDef) => void;
  onParamFormOpen: (type: string) => void;
  onParamFormClose: () => void;
  onParamValuesChange: React.Dispatch<React.SetStateAction<Record<string, Record<string, string | string[]>>>>;
}

function ServiceCatalogAccordion({
  service, defs, subscribedCount, subscribedTypes, subscriptionMap,
  pending, paramFormOpen, paramValues, paramError,
  onToggle, onParamSubmit, onParamFormOpen, onParamFormClose, onParamValuesChange,
}: ServiceCatalogAccordionProps) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className={cn(
      "rounded-lg border overflow-hidden",
      subscribedCount > 0 ? "border-emerald-500/20 bg-emerald-950/10" : "border-border/50 bg-muted/10",
    )}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-white/[0.02] transition-colors"
      >
        <Settings className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground/90 flex-1 text-left capitalize">
          {service}
        </span>
        <span className="text-[10px] text-muted-foreground/50">
          {defs.length} trigger{defs.length !== 1 ? "s" : ""}
        </span>
        {subscribedCount > 0 && (
          <span className="inline-flex items-center justify-center size-4 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px] font-bold">
            {subscribedCount}
          </span>
        )}
        <div className="shrink-0 text-muted-foreground/40">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/30 divide-y divide-border/50">
          {defs.map((def) => {
            const isSubscribed = subscribedTypes.has(def.type);
            const isPendingToggle = pending.has(def.type);
            const isParamFormVisible = paramFormOpen === def.type;
            const sub = subscriptionMap.get(def.type);
            const hasParams = def.params && def.params.length > 0;

            return (
              <div key={def.type} className="px-3 py-2">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-mono text-foreground truncate">{def.type}</span>
                      <Badge variant="outline" className="px-1 py-0 text-[10px] h-4 shrink-0">
                        {def.label}
                      </Badge>
                      {isSubscribed && (
                        <Badge variant="outline" className="px-1 py-0 text-[10px] h-4 border-emerald-500/40 text-emerald-400 shrink-0">
                          subscribed
                        </Badge>
                      )}
                      {hasParams && !isSubscribed && (
                        <Badge variant="outline" className="px-1 py-0 text-[10px] h-4 border-violet-500/30 text-violet-400/70 shrink-0">
                          configurable
                        </Badge>
                      )}
                    </div>
                    {def.description && (
                      <p className="text-[10px] text-muted-foreground/70 mt-0.5 leading-snug">
                        {def.description}
                      </p>
                    )}
                    {/* Show current subscription params */}
                    {isSubscribed && sub?.params && Object.keys(sub.params).length > 0 && (
                      <div className="mt-1 flex items-center gap-1 flex-wrap">
                        {Object.entries(sub.params).map(([k, v]) => (
                          <Badge key={k} variant="outline" className="px-1 py-0 text-[9px] h-3.5 border-emerald-500/20 text-emerald-400/60">
                            {k}={Array.isArray(v) ? v.map(String).join(", ") : String(v)}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {/* Show param definitions when not subscribed */}
                    {hasParams && !isSubscribed && !isParamFormVisible && (
                      <div className="mt-1 space-y-0.5">
                        {def.params!.map((p) => (
                          <div key={p.name} className="text-[9px] text-muted-foreground/50">
                            <span className="font-mono">{p.name}</span>
                            <span className="text-muted-foreground/30">: {p.type}</span>
                            {p.required && <span className="text-amber-400/50 ml-1">required</span>}
                            {p.multiselect && <span className="text-violet-400/50 ml-1">multiselect</span>}
                            {p.enum && (
                              <span className="text-muted-foreground/30 ml-1">
                                {"{" + p.enum.map(String).join(", ") + "}"}
                              </span>
                            )}
                            {p.description && <span className="ml-1">— {p.description}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => onToggle(def, isSubscribed)}
                    disabled={isPendingToggle}
                    className={cn(
                      "shrink-0 p-1 rounded transition-colors",
                      isSubscribed
                        ? "text-emerald-400 hover:text-red-400 hover:bg-red-500/10"
                        : "text-muted-foreground/50 hover:text-emerald-400 hover:bg-emerald-500/10",
                      isPendingToggle && "opacity-50 cursor-not-allowed",
                    )}
                    title={isSubscribed ? "Unsubscribe" : "Subscribe"}
                    aria-label={isSubscribed ? `Unsubscribe from ${def.type}` : `Subscribe to ${def.type}`}
                  >
                    {isPendingToggle ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : isSubscribed ? (
                      <BellOff className="size-3.5" />
                    ) : (
                      <BellRing className="size-3.5" />
                    )}
                  </button>
                </div>

                {/* Inline param form */}
                {isParamFormVisible && hasParams && (
                  <div className="mt-2 rounded border border-violet-500/20 bg-violet-950/10 p-2 space-y-1.5">
                    <div className="text-[10px] font-medium text-violet-300/80">Configure subscription params</div>
                    {def.params!.map((p) => {
                      const currentVal = paramValues[def.type]?.[p.name];
                      const selectedArr = Array.isArray(currentVal) ? currentVal : [];

                      return (
                        <div key={p.name} className="flex items-start gap-1.5">
                          <label className="text-[10px] text-muted-foreground/70 w-20 shrink-0 truncate pt-0.5" title={p.description ?? p.name}>
                            {p.label}{p.required ? <span className="text-amber-400">*</span> : ""}
                          </label>

                          {/* Multiselect: checkboxes for each enum value */}
                          {p.multiselect && p.enum ? (
                            <div className="flex-1 flex flex-wrap gap-x-2.5 gap-y-1">
                              {p.enum.map((opt) => {
                                const optStr = String(opt);
                                const checked = selectedArr.includes(optStr);
                                return (
                                  <label key={optStr} className="flex items-center gap-1 cursor-pointer text-[10px] text-foreground/80">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => {
                                        onParamValuesChange((prev) => {
                                          const cur = Array.isArray(prev[def.type]?.[p.name]) ? [...(prev[def.type][p.name] as string[])] : [];
                                          const next = checked ? cur.filter(v => v !== optStr) : [...cur, optStr];
                                          return { ...prev, [def.type]: { ...prev[def.type], [p.name]: next } };
                                        });
                                      }}
                                      className="accent-primary size-3"
                                    />
                                    {optStr}
                                  </label>
                                );
                              })}
                            </div>

                          /* Enum (single select): dropdown */
                          ) : p.enum ? (
                            <select
                              value={typeof currentVal === "string" ? currentVal : ""}
                              onChange={(e) => onParamValuesChange((prev) => ({
                                ...prev,
                                [def.type]: { ...prev[def.type], [p.name]: e.target.value },
                              }))}
                              className="flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-ring"
                            >
                              <option value="">—</option>
                              {p.enum.map((opt) => (
                                <option key={String(opt)} value={String(opt)}>{String(opt)}</option>
                              ))}
                            </select>

                          /* Boolean */
                          ) : p.type === "boolean" ? (
                            <select
                              value={typeof currentVal === "string" ? currentVal : ""}
                              onChange={(e) => onParamValuesChange((prev) => ({
                                ...prev,
                                [def.type]: { ...prev[def.type], [p.name]: e.target.value },
                              }))}
                              className="flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-ring"
                            >
                              <option value="">—</option>
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>

                          /* Default: text/number input */
                          ) : (
                            <input
                              type={p.type === "number" ? "number" : "text"}
                              placeholder={p.default !== undefined ? String(p.default) : undefined}
                              value={typeof currentVal === "string" ? currentVal : ""}
                              onChange={(e) => onParamValuesChange((prev) => ({
                                ...prev,
                                [def.type]: { ...prev[def.type], [p.name]: e.target.value },
                              }))}
                              className="flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-ring"
                            />
                          )}
                        </div>
                      );
                    })}
                    {paramError && (
                      <p className="text-[9px] text-destructive">{paramError}</p>
                    )}
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-5 text-[10px] px-1.5"
                        onClick={onParamFormClose}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-5 text-[10px] px-1.5"
                        disabled={isPendingToggle}
                        onClick={() => onParamSubmit(def)}
                      >
                        {isPendingToggle ? <Loader2 className="size-2.5 animate-spin mr-1" /> : null}
                        Subscribe
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

// ── Catalog Section (wraps service accordions) ─────────────────────────────
// TriggerCatalogSection is the parent that holds subscribe/param logic
// and delegates rendering per-service to ServiceCatalogAccordion above.

// ── Active Subscriptions Section ───────────────────────────────────────────

function ActiveSubscriptionsSection({ subscriptions }: { subscriptions: TriggerSubscription[] }) {
  if (subscriptions.length === 0) return null;

  return (
    <div>
      <div className="px-3 py-2 flex items-center gap-1.5">
        <BellRing className="size-3 text-emerald-400" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Active Subscriptions ({subscriptions.length})
        </span>
      </div>
      <div className="divide-y divide-border/50">
        {subscriptions.map((sub) => (
          <div key={sub.triggerType} className="flex items-center gap-2 px-3 py-1.5 flex-wrap">
            <span className="text-xs font-mono text-foreground truncate flex-1">{sub.triggerType}</span>
            {sub.params && Object.keys(sub.params).length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                {Object.entries(sub.params).map(([k, v]) => (
                  <Badge key={k} variant="outline" className="px-1 py-0 text-[9px] h-3.5 border-emerald-500/20 text-emerald-400/60">
                    {k}={Array.isArray(v) ? v.map(String).join(", ") : String(v)}
                  </Badge>
                ))}
              </div>
            )}
            <span className="text-[10px] text-muted-foreground/50 shrink-0">on {sub.runnerId.slice(0, 8)}</span>
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
    <div className="border-b border-border/30 last:border-0">
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
            <span className="text-xs font-medium text-foreground truncate">{entry.type}</span>
            <Badge variant="outline" className="px-1 py-0 text-[10px] h-4">
              {sourceLabel(entry.source)}
            </Badge>
            {entry.deliverAs === "steer" ? (
              <Badge variant="outline" className="px-1 py-0 text-[10px] h-4 border-amber-500/40 text-amber-400">
                steer
              </Badge>
            ) : (
              <Badge variant="outline" className="px-1 py-0 text-[10px] h-4 border-blue-500/40 text-blue-400">
                follow-up
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground/70">{formatRelativeTime(entry.ts)}</span>
            {entry.response && (
              <span className="text-[10px] text-emerald-500">
                ✓ {entry.response.action ?? "responded"}
              </span>
            )}
            {entry.summary && (
              <span className="text-[10px] text-muted-foreground/60 truncate">{entry.summary}</span>
            )}
          </div>
        </div>

        {hasPayload && (
          <div className="shrink-0 text-muted-foreground/50">
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </div>
        )}
      </button>

      {expanded && payloadStr && (
        <div className="px-3 pb-2.5">
          <pre className="rounded bg-muted/60 border border-border/50 px-2.5 py-2 text-[10px] font-mono text-foreground/80 overflow-auto max-h-40 whitespace-pre-wrap break-all">
            {payloadStr}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Other Source Group (collapsible group of events from the same source) ──

interface OtherSourceGroupProps {
  group: { source: string; label: string; events: TriggerHistoryEntry[] };
}

function OtherSourceGroup({ group }: OtherSourceGroupProps) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="rounded-lg border border-border/50 bg-muted/10 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors"
      >
        <SourceIcon source={group.source} className="text-muted-foreground" />
        <span className="text-[11px] font-medium text-foreground/90 flex-1 text-left truncate">
          {group.label}
        </span>
        <span className="text-[10px] text-muted-foreground/50 shrink-0">
          {group.events.length} event{group.events.length !== 1 ? "s" : ""}
        </span>
        <div className="shrink-0 text-muted-foreground/40">
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/30">
          {group.events.map((entry) => (
            <OtherTriggerRow key={entry.triggerId} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Source Accordion (unified accordion for any source) ────────────────────

interface SourceAccordionProps {
  group: SourceGroup;
  statusUpdates: Map<string, TriggerStatusUpdate>;
  tick: number;
}

function SourceAccordion({ group, statusUpdates, tick: _tick }: SourceAccordionProps) {
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
    amber: { border: "border-amber-500/30", bg: "bg-amber-950/20", badge: "border-amber-500/40 text-amber-400", icon: "text-amber-400", pulse: true },
    blue: { border: "border-blue-500/30", bg: "bg-blue-950/20", badge: "border-blue-500/40 text-blue-400", icon: "text-blue-400", pulse: true },
    red: { border: "border-red-500/30", bg: "bg-red-950/20", badge: "border-red-500/40 text-red-400", icon: "text-red-400", pulse: true },
    emerald: { border: "border-emerald-500/20", bg: "bg-emerald-950/10", badge: "border-emerald-500/40 text-emerald-400", icon: "text-emerald-400", pulse: false },
    zinc: { border: "border-border/50", bg: "bg-muted/10", badge: "border-border text-muted-foreground", icon: "text-muted-foreground", pulse: false },
  };

  const colors = status ? colorMap[status.color] : { border: "border-border/50", bg: "bg-muted/10", badge: "border-border text-muted-foreground", icon: "text-muted-foreground", pulse: false };

  return (
    <div className={cn("rounded-lg border overflow-hidden", colors.border, colors.bg)}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.02]"
      >
        {/* Icon */}
        <div className={cn("mt-0.5 shrink-0", colors.icon, colors.pulse && "animate-pulse")}>
          {status ? status.icon : <SourceIcon source={group.source} />}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Name + status badge */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-mono text-foreground/90 truncate">
              {group.lastSummary || group.label || truncateId(group.source)}
            </span>
            {status && (
              <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px] h-4 shrink-0", colors.badge)}>
                {status.label}
              </Badge>
            )}
          </div>

          {/* Pending trigger detail */}
          {isPending && group.isLinkedSession && (
            <div className="mt-1">
              <span className={cn("text-[11px] font-medium", status ? `text-${status.color}-300` : "text-amber-300")}>
                {group.pendingTrigger!.type === "ask_user_question" && "Waiting for your answer"}
                {group.pendingTrigger!.type === "plan_review" && "Waiting for plan approval"}
                {group.pendingTrigger!.type === "session_complete" && "Session finished — needs acknowledgement"}
                {group.pendingTrigger!.type === "escalate" && "Escalated — needs human attention"}
                {!["ask_user_question", "plan_review", "session_complete", "escalate"].includes(group.pendingTrigger!.type) && `Awaiting response to ${group.pendingTrigger!.type}`}
              </span>
              <span className="text-[10px] text-muted-foreground/60 ml-2">
                {formatRelativeTime(group.pendingTrigger!.ts)}
              </span>
            </div>
          )}

          {/* Streaming status update */}
          {latestStatusUpdate && (
            <div className="mt-1 flex items-center gap-1.5">
              <Loader2 className="size-2.5 animate-spin text-muted-foreground/60 shrink-0" />
              <span className="text-[10px] text-muted-foreground/80 italic truncate">
                {latestStatusUpdate.statusText}
              </span>
            </div>
          )}

          {/* Last event + time */}
          {!isPending && !latestStatusUpdate && (
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] text-muted-foreground/60">
                Last: <span className="text-muted-foreground/80">{group.events[0]?.type}</span>
              </span>
              <span className="text-[10px] text-muted-foreground/40">
                {formatRelativeTime(group.lastTs)}
              </span>
            </div>
          )}

          {/* Event count + source ID hint */}
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-muted-foreground/40">
              {group.events.length} event{group.events.length !== 1 ? "s" : ""}
            </span>
            {group.lastSummary && group.isLinkedSession && (
              <span className="text-[10px] font-mono text-muted-foreground/30 truncate">
                {truncateId(group.source)}
              </span>
            )}
          </div>
        </div>

        {/* Expand chevron */}
        <div className="mt-0.5 shrink-0 text-muted-foreground/40">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </div>
      </button>

      {/* Expanded event history */}
      {expanded && (
        <div className={cn("border-t", colors.border)}>
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

  // Tick counter for re-rendering relative times
  const [tick, setTick] = React.useState(0);

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

  // Tick timer for relative time updates (every 5s)
  React.useEffect(() => {
    const timer = setInterval(() => { setTick((t) => t + 1); }, 5_000);
    return () => clearInterval(timer);
  }, []);

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
  const [activeTab, setActiveTab] = React.useState<"history" | "catalog">(hasCatalog ? "catalog" : "history");

  // Count for badges
  const pendingCount = pendingGroups.length;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar with tabs */}
      <div className="flex items-center border-b border-border bg-muted/20 shrink-0">
        {/* Tab buttons */}
        <div className="flex items-center flex-1 min-w-0 gap-0">
          <button
            type="button"
            onClick={() => setActiveTab("history")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2",
              activeTab === "history"
                ? "text-foreground border-primary"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            <Clock className="size-3" />
            History
            {pendingCount > 0 && (
              <span className="inline-flex items-center justify-center size-4 rounded-full bg-amber-500/20 text-amber-400 text-[9px] font-bold">
                {pendingCount}
              </span>
            )}
          </button>

          {hasCatalog && (
            <button
              type="button"
              onClick={() => setActiveTab("catalog")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2",
                activeTab === "catalog"
                  ? "text-foreground border-primary"
                  : "text-muted-foreground hover:text-foreground border-transparent",
              )}
            >
              <BookOpen className="size-3" />
              Catalog
              {subscriptions.length > 0 && (
                <span className="inline-flex items-center justify-center size-4 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px] font-bold">
                  {subscriptions.length}
                </span>
              )}
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 px-2 shrink-0">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="Refresh"
            aria-label="Refresh trigger history"
          >
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          </button>

          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[11px] px-2 gap-1"
            onClick={() => setSendOpen(true)}
          >
            <Send className="size-3" />
            Send
          </Button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* ─── History tab ─── */}
        {activeTab === "history" && (
          <>
            {loading ? (
              <div className="flex items-center justify-center h-32 gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span className="text-xs">Loading triggers…</span>
              </div>
            ) : error ? (
              <div className="flex items-center justify-center p-4">
                <p className="text-xs text-destructive text-center">{error}</p>
              </div>
            ) : triggers.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                <Zap className="size-8 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">
                  No triggers yet. External systems can send triggers via the API.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 p-2">
                {sourceGroups.map((group) => (
                  <SourceAccordion
                    key={group.source}
                    group={group}
                    statusUpdates={statusUpdates}
                    tick={tick}
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
              <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
                <BookOpen className="size-8 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">
                  No trigger types available. Runner services can declare triggers for agents to subscribe to.
                </p>
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
