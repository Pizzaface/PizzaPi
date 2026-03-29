/**
 * RunnerTriggersPanel — runner-level trigger catalog.
 *
 * Shows available trigger types from runner services grouped by service
 * prefix as collapsible accordions. Purely informational — shows what
 * trigger types are available on this runner for sessions to subscribe to.
 */
import * as React from "react";
import {
  Settings,
  ChevronDown,
  ChevronRight,
  Loader2,
  BookOpen,
  BellRing,
  BellOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ServiceTriggerDef } from "@pizzapi/protocol";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract the service prefix from a namespaced trigger type (e.g. "godmother" from "godmother:idea_moved"). */
function servicePrefix(type: string): string {
  const idx = type.indexOf(":");
  return idx > 0 ? type.slice(0, idx) : type;
}

/** Extract the event name after the colon (e.g. "idea_moved" from "godmother:idea_moved"). */
function eventName(type: string): string {
  const idx = type.indexOf(":");
  return idx > 0 ? type.slice(idx + 1) : type;
}

// ── Service Group ──────────────────────────────────────────────────────────

interface ServiceGroup {
  service: string;
  defs: ServiceTriggerDef[];
}

function groupByService(defs: ServiceTriggerDef[]): ServiceGroup[] {
  const map = new Map<string, ServiceTriggerDef[]>();
  for (const def of defs) {
    const svc = servicePrefix(def.type);
    const existing = map.get(svc);
    if (existing) {
      existing.push(def);
    } else {
      map.set(svc, [def]);
    }
  }
  return Array.from(map.entries()).map(([service, d]) => ({ service, defs: d }));
}

// ── Service Accordion ──────────────────────────────────────────────────────

interface ServiceAccordionProps {
  group: ServiceGroup;
  listenedTypes: Set<string>;
  pendingTypes: Set<string>;
  onToggleListener: (triggerType: string, isListening: boolean) => void;
}

function ServiceAccordion({ group, listenedTypes, pendingTypes, onToggleListener }: ServiceAccordionProps) {
  const [expanded, setExpanded] = React.useState(false);
  const listenedCount = group.defs.filter((d) => listenedTypes.has(d.type)).length;

  return (
    <div className={cn(
      "rounded-lg border overflow-hidden",
      listenedCount > 0 ? "border-emerald-500/20 bg-emerald-950/10" : "border-border/50 bg-muted/10",
    )}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-white/[0.02] transition-colors"
      >
        <Settings className="size-3.5 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground/90 flex-1 text-left capitalize">
          {group.service}
        </span>
        <span className="text-xs text-muted-foreground/50">
          {group.defs.length} trigger{group.defs.length !== 1 ? "s" : ""}
        </span>
        {listenedCount > 0 && (
          <span className="inline-flex items-center justify-center size-4 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px] font-bold">
            {listenedCount}
          </span>
        )}
        <div className="shrink-0 text-muted-foreground/40">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/30 divide-y divide-border/30">
          {group.defs.map((def) => {
            const isListening = listenedTypes.has(def.type);
            const isPending = pendingTypes.has(def.type);
            return (
              <div key={def.type} className="px-3 py-2.5 flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-mono text-foreground">
                      {eventName(def.type)}
                    </span>
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 shrink-0">
                      {def.label}
                    </Badge>
                    {isListening && (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-emerald-500/40 text-emerald-400 shrink-0">
                        auto-spawn
                      </Badge>
                    )}
                  </div>
                  {def.description && (
                    <p className="text-[11px] text-muted-foreground/70 mt-0.5 leading-snug">
                      {def.description}
                    </p>
                  )}
                  {def.params && def.params.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {def.params.map((p) => (
                        <div key={p.name} className="text-[10px] text-muted-foreground/50">
                          <span className="font-mono">{p.name}</span>
                          <span className="text-muted-foreground/30">: {p.type}</span>
                          {p.required && <span className="text-amber-400/50 ml-1">required</span>}
                          {p.description && <span className="ml-1">— {p.description}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => onToggleListener(def.type, isListening)}
                  disabled={isPending}
                  className={cn(
                    "shrink-0 p-1.5 rounded transition-colors",
                    isListening
                      ? "text-emerald-400 hover:text-red-400 hover:bg-red-500/10"
                      : "text-muted-foreground/50 hover:text-emerald-400 hover:bg-emerald-500/10",
                    isPending && "opacity-50 cursor-not-allowed",
                  )}
                  title={isListening ? "Remove auto-spawn listener" : "Add auto-spawn listener — spawns a new session when this trigger fires"}
                  aria-label={isListening ? `Remove listener for ${def.type}` : `Add listener for ${def.type}`}
                >
                  {isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : isListening ? (
                    <BellOff className="size-4" />
                  ) : (
                    <BellRing className="size-4" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────────

export interface RunnerTriggersPanelProps {
  runnerId: string;
  /** Optional pre-loaded trigger defs (skips fetch if provided and non-empty). */
  triggerDefs?: ServiceTriggerDef[];
}

interface ListenerInfo {
  triggerType: string;
  prompt?: string;
  cwd?: string;
  createdAt: string;
}

export function RunnerTriggersPanel({ runnerId, triggerDefs: propDefs }: RunnerTriggersPanelProps) {
  const [fetchedDefs, setFetchedDefs] = React.useState<ServiceTriggerDef[]>([]);
  const [listeners, setListeners] = React.useState<ListenerInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingTypes, setPendingTypes] = React.useState<Set<string>>(new Set());

  const fetchData = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/triggers`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { triggerDefs?: ServiceTriggerDef[]; listeners?: ListenerInfo[] };
      setFetchedDefs(data.triggerDefs ?? []);
      setListeners(data.listeners ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load triggers");
    } finally {
      setLoading(false);
    }
  }, [runnerId]);

  React.useEffect(() => {
    if (propDefs && propDefs.length > 0) {
      // Still fetch listeners even if defs are provided
      void (async () => {
        try {
          const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners`, {
            credentials: "include",
          });
          if (res.ok) {
            const data = await res.json() as { listeners?: ListenerInfo[] };
            setListeners(data.listeners ?? []);
          }
        } catch { /* best-effort */ }
      })();
      return;
    }
    void fetchData();
  }, [runnerId, propDefs, fetchData]);

  const triggerDefs = (propDefs && propDefs.length > 0) ? propDefs : fetchedDefs;
  const serviceGroups = React.useMemo(() => groupByService(triggerDefs), [triggerDefs]);
  const listenedTypes = React.useMemo(() => new Set(listeners.map((l) => l.triggerType)), [listeners]);

  const handleToggleListener = React.useCallback(async (triggerType: string, isListening: boolean) => {
    setPendingTypes((prev) => new Set([...prev, triggerType]));
    try {
      if (isListening) {
        await fetch(
          `/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners/${encodeURIComponent(triggerType)}`,
          { method: "DELETE", credentials: "include" },
        );
        setListeners((prev) => prev.filter((l) => l.triggerType !== triggerType));
      } else {
        await fetch(
          `/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ triggerType }),
          },
        );
        setListeners((prev) => [...prev, { triggerType, createdAt: new Date().toISOString() }]);
      }
    } catch { /* best-effort */ } finally {
      setPendingTypes((prev) => {
        const next = new Set(prev);
        next.delete(triggerType);
        return next;
      });
    }
  }, [runnerId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span className="text-sm">Loading triggers…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center p-6">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (triggerDefs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <BookOpen className="size-10 text-muted-foreground/30" />
        <div>
          <p className="text-sm text-muted-foreground">No trigger types available</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Runner services can declare triggers that agents subscribe to.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {serviceGroups.map((group) => (
        <ServiceAccordion
          key={group.service}
          group={group}
          listenedTypes={listenedTypes}
          pendingTypes={pendingTypes}
          onToggleListener={handleToggleListener}
        />
      ))}
    </div>
  );
}
