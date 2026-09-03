/**
 * EventsRoutesPanel — unified trigger system admin surface (ADR-0002).
 *
 * Two tabs:
 *   • Events  — the global Event feed (GET /api/events) with expandable
 *               per-event Deliveries and inline responses against a
 *               Delivery's Response Contract.
 *   • Routes  — Route management (GET/POST/PUT/DELETE /api/routes).
 *               Config-origin routes render read-only with a badge — the
 *               config file is their source of truth.
 *
 * Data comes from the unified HTTP API only; no legacy trigger endpoints.
 */

import * as React from "react";
import {
  type Delivery,
  type DeliveryView,
  type Route,
  type ServiceTriggerDef,
  type TriggerEvent,
} from "@pizzapi/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Trash2, RefreshCw, Lock, ChevronRight, ChevronDown, Zap, Pencil, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { RouteForm } from "./RouteForm";
import {
  api,
  canRespond,
  DELIVERY_STATUS_META,
  eventSourceLabel,
  eventTitle,
  isReadOnlyRoute,
  summarizeRouteTarget,
  timeAgo,
} from "./events-format";

// ── Small shared pieces ──────────────────────────────────────────────────────

function StatusChip({ status }: { status: Delivery["status"] }) {
  const meta = DELIVERY_STATUS_META[status];
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", meta.className)}>
      {meta.label}
    </span>
  );
}

function OriginBadge({ origin }: { origin: Route["origin"] }) {
  if (origin === "config") {
    return (
      <Badge variant="outline" className="gap-1 text-[11px] border-border text-muted-foreground">
        <Lock className="h-3 w-3" /> config
      </Badge>
    );
  }
  return <Badge variant="secondary" className="text-[11px]">{origin}</Badge>;
}

function ErrorNote({ message }: { message: string }) {
  return <p className="text-sm text-destructive">{message}</p>;
}

// ── Event feed ───────────────────────────────────────────────────────────────

function DeliveryRow({ delivery, onResponded }: { delivery: DeliveryView; onResponded: () => void }) {
  const [responding, setResponding] = React.useState(false);
  const [responseText, setResponseText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  // Server-stamped view fields: respondable comes from the event's
  // ResponseContract, actions drive one button per declared action.
  const actions = delivery.actions ?? [];

  const respond = async (action?: string) => {
    if (!responseText.trim() && !action) return;
    setResponding(true);
    setError(null);
    try {
      await api(`/api/deliveries/${encodeURIComponent(delivery.deliveryId)}/response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: responseText.trim() || action!, ...(action ? { action } : {}) }),
      });
      onResponded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Respond failed");
    } finally {
      setResponding(false);
    }
  };

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2">
        <StatusChip status={delivery.status} />
        <span className="font-mono text-[11px] text-muted-foreground truncate">{delivery.eventType}</span>
        <span className="font-mono text-[11px] text-muted-foreground shrink-0">→ {delivery.sessionId.slice(0, 8)}</span>
        <span className="text-[11px] text-muted-foreground shrink-0">{timeAgo(delivery.createdAt)}</span>
        <span className="text-[11px] text-muted-foreground shrink-0">{delivery.deliverAs}</span>
        {delivery.response && (
          <span className="text-[11px] text-muted-foreground truncate">
            {delivery.response.action ? `[${delivery.response.action}] ` : ""}{delivery.response.text}
          </span>
        )}
      </div>
      {canRespond(delivery) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            aria-label={`Response to delivery ${delivery.deliveryId}`}
            value={responseText}
            onChange={(e) => setResponseText(e.target.value)}
            placeholder={actions.length > 0 ? "Message (optional)…" : "Response…"}
            className="h-7 max-w-xs text-xs"
            onKeyDown={(e) => { if (e.key === "Enter") void respond(); }}
          />
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={responding} onClick={() => void respond()}>
            {responding ? <Spinner className="h-3 w-3" /> : "Send"}
          </Button>
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant="outline"
              className={cn("h-7 px-2 text-xs", action === "cancel" && "text-destructive", action === "approve" && "text-emerald-600")}
              disabled={responding}
              onClick={() => void respond(action)}
            >
              {action}
            </Button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}

function EventRow({ event, onResponded }: { event: TriggerEvent; onResponded?: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [deliveries, setDeliveries] = React.useState<DeliveryView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && deliveries === null) {
      setError(null);
      try {
        const data = await api<{ deliveries: DeliveryView[] }>(`/api/events/${encodeURIComponent(event.eventId)}/deliveries`);
        setDeliveries(data.deliveries ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load deliveries");
      }
    }
  };

  return (
    <div className="rounded-md border border-border/60">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <Zap className="h-3.5 w-3.5 shrink-0 text-accent-foreground/70" />
        <span className="min-w-0 flex-1 truncate text-sm">{eventTitle(event)}</span>
        {event.responseContract && (
          <Badge variant="outline" className="text-[10px]">contract</Badge>
        )}
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{event.type}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{eventSourceLabel(event.source)}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(event.ts)}</span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-border/60 px-3 py-2">
          {error && <ErrorNote message={error} />}
          {deliveries === null && !error && <Spinner className="h-4 w-4" />}
          {deliveries?.length === 0 && <p className="text-xs text-muted-foreground">No deliveries — no route matched this event.</p>}
          {deliveries?.map((d) => (
            <DeliveryRow key={d.deliveryId} delivery={d} onResponded={() => {
              setDeliveries((prev) => prev?.map((x) =>
                x.deliveryId === d.deliveryId
                  ? { ...x, status: "responded" as const, respondable: false, respondedAt: new Date().toISOString() }
                  : x,
              ) ?? prev);
              onResponded?.();
            }} />
          ))}
        </div>
      )}
    </div>
  );
}

function DeliveriesTab({ sessionId, viewerSocket, onResponded }: { sessionId: string; viewerSocket?: unknown; onResponded?: () => void }) {
  const [deliveries, setDeliveries] = React.useState<DeliveryView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const generation = React.useRef(0);
  const request = React.useRef<AbortController | null>(null);

  const load = React.useCallback(async () => {
    const current = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    try {
      const data = await api<{ deliveries: DeliveryView[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/deliveries`, {
        signal: controller.signal,
      });
      if (current === generation.current) setDeliveries(data.deliveries ?? []);
    } catch (err) {
      if (current === generation.current && !controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "Failed to load deliveries");
      }
    }
  }, [sessionId]);

  React.useEffect(() => {
    setDeliveries(null);
    setError(null);
    void load();
    return () => {
      generation.current += 1;
      request.current?.abort();
    };
  }, [load]);

  // Live: the server broadcasts trigger_delivered to session viewers.
  React.useEffect(() => {
    const sock = viewerSocket as { on?: (ev: string, fn: () => void) => void; off?: (ev: string, fn: () => void) => void } | undefined;
    if (!sock?.on) return;
    const handler = () => void load();
    sock.on("trigger_delivered", handler);
    return () => { sock.off?.("trigger_delivered", handler); };
  }, [viewerSocket, load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Deliveries to this session</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void load()} title="Refresh" aria-label="Refresh deliveries">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && <ErrorNote message={error} />}
      {deliveries === null && !error && <Spinner className="h-4 w-4" />}
      {deliveries?.length === 0 && (
        <p className="text-sm text-muted-foreground">No deliveries yet. Events routed to this session appear here.</p>
      )}
      <ScrollArea className="max-h-[60vh] pr-2">
        <div className="space-y-1.5">
          {deliveries?.map((d) => (
            <DeliveryRow
              key={d.deliveryId}
              delivery={d}
              onResponded={() => {
                setDeliveries((prev) => prev?.map((x) =>
                  x.deliveryId === d.deliveryId
                    ? { ...x, status: "responded" as const, respondable: false, respondedAt: new Date().toISOString() }
                    : x,
                ) ?? prev);
                onResponded?.();
              }}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function EventsTab({ onResponded }: { onResponded?: () => void }) {
  const [events, setEvents] = React.useState<TriggerEvent[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const generation = React.useRef(0);
  const request = React.useRef<AbortController | null>(null);

  const load = React.useCallback(async () => {
    const current = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError(null);
    try {
      const data = await api<{ events: TriggerEvent[] }>("/api/events?limit=100", { signal: controller.signal });
      if (current === generation.current) setEvents(data.events ?? []);
    } catch (err) {
      if (current === generation.current && !controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "Failed to load events");
      }
    }
  }, []);

  React.useEffect(() => {
    setEvents(null);
    setError(null);
    void load();
    return () => {
      generation.current += 1;
      request.current?.abort();
    };
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Event feed</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void load()} title="Refresh" aria-label="Refresh event feed">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && <ErrorNote message={error} />}
      {events === null && !error && <Spinner className="h-4 w-4" />}
      {events?.length === 0 && (
        <p className="text-sm text-muted-foreground">No events yet. Published events appear here for 30 days.</p>
      )}
      <ScrollArea className="max-h-[60vh] pr-2">
        <div className="space-y-1.5">
          {events?.map((e) => <EventRow key={e.eventId} event={e} onResponded={onResponded} />)}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** GET /api/routes decorates routes whose runner the server has declared dead. */
type ListedRoute = Route & { runnerDead?: boolean; runnerDeadSince?: string };

function RouteRow({ route, onDeleted, onChanged, onEdit }: { route: ListedRoute; onDeleted: (id: string) => void; onChanged: () => void; onEdit: (route: Route) => void }) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const readOnly = isReadOnlyRoute(route);
  // Config routes are owned by the config file; spawn routes are managed by
  // their runner's trigger listeners panel. Only session routes are editable here.
  const editable = !readOnly && route.target.kind === "session";

  React.useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/routes/${encodeURIComponent(route.routeId)}`, { method: "DELETE" });
      onDeleted(route.routeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const toggleDeliverAs = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/routes/${encodeURIComponent(route.routeId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliverAs: route.deliverAs === "steer" ? "followUp" : "steer" }),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs">{route.eventType}</span>
          <OriginBadge origin={route.origin} />
          <Badge variant="outline" className="text-[10px]">{route.deliverAs}</Badge>
          {route.filters && route.filters.length > 0 && (
            <Badge variant="outline" className="text-[10px]" title={route.filters.map((f) => `${f.field} ${f.op ?? "eq"} ${JSON.stringify(f.value)}`).join(route.filterMode === "or" ? " OR " : ", ")}>
              {route.filters.length} filter{route.filters.length === 1 ? "" : "s"}{route.filterMode === "or" ? " (or)" : ""}
            </Badge>
          )}
          {route.params && Object.keys(route.params).length > 0 && (
            <Badge variant="outline" className="text-[10px]" title={Object.entries(route.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}>
              {Object.keys(route.params).length} param{Object.keys(route.params).length === 1 ? "" : "s"}
            </Badge>
          )}
          {route.runnerDead && (
            <Badge variant="outline" className="gap-1 text-[10px] border-amber-500/40 text-amber-600 dark:text-amber-400" title="No runner has registered under this id for over 7 days — this route can no longer fire. Delete it, or reinstall the runner.">
              <WifiOff className="h-3 w-3" />
              runner offline{route.runnerDeadSince ? ` since ${new Date(route.runnerDeadSince).toLocaleDateString()}` : ""}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{summarizeRouteTarget(route.target)}</p>
        {error && <p className="mt-0.5 text-[11px] text-destructive" role="alert">{error}</p>}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2 text-[11px]"
        disabled={readOnly || busy}
        onClick={() => void toggleDeliverAs()}
        title={readOnly ? "Config routes are read-only — edit the config file instead" : `Switch to ${route.deliverAs === "steer" ? "followUp" : "steer"}`}
      >
        {route.deliverAs === "steer" ? "→ followUp" : "→ steer"}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        disabled={!editable || busy}
        onClick={() => onEdit(route)}
        title={!editable
          ? (readOnly ? "Config routes are read-only — edit the config file instead" : "Spawn-target routes are managed by their runner panel")
          : "Edit route (params, filters, delivery)"}
        aria-label={editable ? "Edit route" : "Route editing unavailable"}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      {busy ? (
        <Spinner className="h-3.5 w-3.5 text-destructive" />
      ) : confirming ? (
        <Button variant="destructive" size="sm" className="h-7 px-2 text-xs" onClick={() => void remove()}>Sure?</Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          disabled={readOnly}
          onClick={() => setConfirming(true)}
          title={readOnly ? "Config routes are read-only — edit the config file instead" : "Delete route"}
          aria-label="Delete route"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

function RoutesTab({ sessionId, onMutated }: { sessionId?: string; onMutated?: () => void }) {
  const [routes, setRoutes] = React.useState<Route[] | null>(null);
  const [catalog, setCatalog] = React.useState<ServiceTriggerDef[]>([]);
  const [editing, setEditing] = React.useState<Route | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ routes: ListedRoute[] }>("/api/routes");
      setRoutes(data.routes ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load routes");
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  // Runner service catalog: params/schemas for the type picker. Session-scoped
  // only — the catalog endpoint resolves through the session's runner. Without
  // a session (or on failure) the form falls back to free-text types.
  React.useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    api<{ triggerDefs: ServiceTriggerDef[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/available-triggers`)
      .then((data) => { if (!cancelled) setCatalog(data.triggerDefs ?? []); })
      .catch(() => { /* free-text fallback */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  const afterMutation = () => {
    setEditing(null);
    void load();
    onMutated?.();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Routes</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void load()} title="Refresh" aria-label="Refresh routes">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <RouteForm
        catalog={catalog}
        targetSessionId={sessionId}
        editing={editing}
        onDone={afterMutation}
        onCancel={() => setEditing(null)}
      />
      {editing && (
        <p className="text-[11px] text-muted-foreground">Editing <span className="font-mono">{editing.eventType}</span> — save or cancel to add a new route.</p>
      )}
      {error && <ErrorNote message={error} />}
      {routes === null && !error && <Spinner className="h-4 w-4" />}
      {routes?.length === 0 && (
        <p className="text-sm text-muted-foreground">No routes yet. Create one above, or subscribe from a session's trigger catalog.</p>
      )}
      <ScrollArea className="max-h-[55vh] pr-2">
        <div className="space-y-1.5">
          {routes?.map((r) => (
            <RouteRow
              key={r.routeId}
              route={r}
              onDeleted={(id) => { setRoutes((prev) => prev?.filter((x) => x.routeId !== id) ?? prev); onMutated?.(); }}
              onChanged={afterMutation}
              onEdit={setEditing}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
// ── Panel shell ──────────────────────────────────────────────────────────────

export function EventsRoutesPanel({
  bare = false,
  sessionId,
  viewerSocket,
  onBadgeRefresh,
}: {
  bare?: boolean;
  sessionId?: string;
  viewerSocket?: unknown;
  /** useTriggerCount().refresh — called after every mutation so badges update. */
  onBadgeRefresh?: () => void;
}) {
  const [tab, setTab] = React.useState<"events" | "routes" | "deliveries">(sessionId ? "deliveries" : "events");

  // Session-scoped mode: deliveries to this session plus its route management
  // (the catalog-driven form targets the session). Global mode: event feed + routes.
  const tabs = (sessionId
    ? ([
        ["deliveries", "Deliveries"],
        ["routes", "Routes"],
      ] as const)
    : ([
        ["events", "Event feed"],
        ["routes", "Routes"],
      ] as const)
  );

  const body = (
    <div className="space-y-4">
      <div role="tablist" aria-label="Events and routes views" className="flex items-center gap-1 rounded-lg bg-muted p-1 w-fit">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`events-routes-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`events-routes-panel-${t}`}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium transition-colors",
              tab === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>))}
      </div>
      <div id={`events-routes-panel-${tab}`} role="tabpanel" aria-labelledby={`events-routes-tab-${tab}`}>
        {sessionId ? (
          tab === "deliveries" ? (
            <DeliveriesTab key={sessionId} sessionId={sessionId} viewerSocket={viewerSocket} onResponded={onBadgeRefresh} />
          ) : (
            <RoutesTab sessionId={sessionId} onMutated={onBadgeRefresh} />
          )
        ) : tab === "events" ? (
          <EventsTab onResponded={onBadgeRefresh} />
        ) : (
          <RoutesTab onMutated={onBadgeRefresh} />
        )}
      </div>
    </div>
  );

  if (bare) return body;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Events & Routes</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

export default EventsRoutesPanel;