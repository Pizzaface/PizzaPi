/**
 * TriggersPanel — shows trigger history, linked child sessions, and a manual send form.
 *
 * Fetches from GET /api/sessions/:id/triggers and auto-refreshes every 10s.
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

interface LinkedSession {
  source: string;
  lastType: string;
  lastTs: string;
  count: number;
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
  // Looks like a session (hex ID or named session) — treat as child session
  if (src.length >= 8 && /^[a-z0-9-]+$/.test(src)) return <Link className={cn("size-3.5", className)} />;
  return <Wrench className={cn("size-3.5", className)} />;
}

function sourceLabel(source: string): string {
  if (!source || source === "api") return "API";
  if (source.startsWith("external:")) return source.slice(9);
  return source;
}

/** Extract linked child sessions from inbound triggers that aren't from "api". */
function deriveLinkedSessions(triggers: TriggerHistoryEntry[]): LinkedSession[] {
  const map = new Map<string, LinkedSession>();
  for (const t of triggers) {
    // Only show inbound triggers from non-external sources (child sessions)
    if (t.direction !== "inbound") continue;
    if (t.source === "api" || t.source.startsWith("external:")) continue;
    const existing = map.get(t.source);
    if (!existing) {
      map.set(t.source, { source: t.source, lastType: t.type, lastTs: t.ts, count: 1 });
    } else {
      existing.count++;
      // Keep the most recent
      if (new Date(t.ts) > new Date(existing.lastTs)) {
        existing.lastType = t.type;
        existing.lastTs = t.ts;
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => new Date(b.lastTs).getTime() - new Date(a.lastTs).getTime());
}

// ── Send Trigger Dialog ────────────────────────────────────────────────────

interface SendTriggerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  onSent: () => void;
}

function SendTriggerDialog({ open, onOpenChange, sessionId, onSent }: SendTriggerDialogProps) {
  const [triggerType, setTriggerType] = React.useState("");
  const [source, setSource] = React.useState("");
  const [payloadText, setPayloadText] = React.useState("{}");
  const [deliverAs, setDeliverAs] = React.useState<"steer" | "followUp">("steer");
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset state when dialog opens
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
          {/* Type */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Type <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              placeholder="e.g. webhook, custom_event"
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value)}
              className="w-full rounded border border-border bg-background px-2.5 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Source */}
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

          {/* Payload */}
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

          {/* DeliverAs */}
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
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={sending}
          >
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

// ── Trigger Row ────────────────────────────────────────────────────────────

function TriggerRow({ entry }: { entry: TriggerHistoryEntry }) {
  const [expanded, setExpanded] = React.useState(false);

  const hasPayload = Object.keys(entry.payload).length > 0;
  const payloadStr = hasPayload ? JSON.stringify(entry.payload, null, 2) : null;

  return (
    <div className="border-b border-border/50 last:border-0">
      <button
        type="button"
        onClick={() => hasPayload && setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-start gap-2 px-3 py-2.5 text-left transition-colors",
          hasPayload ? "hover:bg-muted/40 cursor-pointer" : "cursor-default",
        )}
      >
        {/* Direction arrow */}
        <div className="mt-0.5 shrink-0">
          {entry.direction === "inbound" ? (
            <ArrowDownCircle className="size-3.5 text-blue-400" />
          ) : (
            <ArrowUpCircle className="size-3.5 text-violet-400" />
          )}
        </div>

        {/* Source icon */}
        <div className="mt-0.5 shrink-0 text-muted-foreground">
          <SourceIcon source={entry.source} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium text-foreground truncate">{entry.type}</span>
            <Badge
              variant="outline"
              className="px-1 py-0 text-[10px] h-4"
            >
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

        {/* Expand chevron */}
        {hasPayload && (
          <div className="mt-0.5 shrink-0 text-muted-foreground/50">
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </div>
        )}
      </button>

      {/* Expanded payload */}
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

// ── Linked Sessions Section ────────────────────────────────────────────────

function LinkedSessionsSection({ sessions }: { sessions: LinkedSession[] }) {
  if (sessions.length === 0) return null;

  return (
    <div className="border-b border-border">
      <div className="px-3 py-2 flex items-center gap-1.5">
        <Link className="size-3 text-muted-foreground" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Linked Sessions ({sessions.length})
        </span>
      </div>
      <div className="divide-y divide-border/50">
        {sessions.map((session) => (
          <div key={session.source} className="flex items-center gap-2 px-3 py-2">
            <div className="shrink-0 text-muted-foreground">
              <SourceIcon source={session.source} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-mono text-foreground truncate">{session.source}</span>
                <Badge variant="outline" className="px-1 py-0 text-[10px] h-4 border-emerald-500/40 text-emerald-400">
                  active
                </Badge>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-muted-foreground/70">
                  Last: <span className="text-muted-foreground">{session.lastType}</span>
                </span>
                <span className="text-[10px] text-muted-foreground/50">{formatRelativeTime(session.lastTs)}</span>
                {session.count > 1 && (
                  <span className="text-[10px] text-muted-foreground/50">{session.count} triggers</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────────

export interface TriggersPanelProps {
  sessionId: string;
}

export function TriggersPanel({ sessionId }: TriggersPanelProps) {
  const [triggers, setTriggers] = React.useState<TriggerHistoryEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [sendOpen, setSendOpen] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const fetchTriggers = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);

    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/triggers?limit=50`,
        { credentials: "include" },
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json() as { triggers: TriggerHistoryEntry[] };
      setTriggers(data.triggers ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load triggers");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sessionId]);

  // Initial fetch
  React.useEffect(() => {
    void fetchTriggers(false);
  }, [fetchTriggers]);

  // Auto-refresh every 10s
  React.useEffect(() => {
    const timer = setInterval(() => { void fetchTriggers(true); }, 10_000);
    return () => clearInterval(timer);
  }, [fetchTriggers]);

  const linkedSessions = React.useMemo(() => deriveLinkedSessions(triggers), [triggers]);

  const handleRefresh = React.useCallback(() => {
    void fetchTriggers(true);
  }, [fetchTriggers]);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/20 shrink-0">
        <span className="text-xs font-medium text-muted-foreground flex-1">Trigger History</span>

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
          Send Trigger
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-xs">Loading triggers…</span>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full p-4">
            <p className="text-xs text-destructive text-center">{error}</p>
          </div>
        ) : triggers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 p-6 text-center">
            <Zap className="size-8 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">
              No triggers yet. External systems can send triggers via the API.
            </p>
          </div>
        ) : (
          <>
            <LinkedSessionsSection sessions={linkedSessions} />
            <div className="divide-y divide-border/30">
              {triggers.map((entry) => (
                <TriggerRow key={entry.triggerId} entry={entry} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Send Trigger Dialog */}
      <SendTriggerDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        sessionId={sessionId}
        onSent={() => { void fetchTriggers(true); }}
      />
    </div>
  );
}
