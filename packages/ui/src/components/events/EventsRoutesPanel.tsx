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
import { Trash2, RefreshCw, Lock, ChevronRight, ChevronDown, Zap, Pencil, Play, Pause, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { RouteForm } from "./RouteForm";
import type { TriggerRuntimeStatus } from "@pizzapi/protocol";
import {
  api,
  canRespond,
  DELIVERY_STATUS_META,
  eventSourceLabel,
  eventTitle,
  isReadOnlyRoute,
  payloadForRouteFilters,
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
        {delivery.failureReason && <span className="text-[11px] text-destructive">{delivery.failureReason === "offline_policy" ? "Offline policy rejected delivery" : delivery.failureReason}</span>}
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

function EventRow({ event, runnerId, onResponded }: { event: TriggerEvent; runnerId?: string; onResponded?: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [deliveries, setDeliveries] = React.useState<DeliveryView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && deliveries === null) {
      setError(null);
      try {
        const query = runnerId ? `?runnerId=${encodeURIComponent(runnerId)}` : "";
        const data = await api<{ deliveries: DeliveryView[] }>(`/api/events/${encodeURIComponent(event.eventId)}/deliveries${query}`);
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

function EventsTab({ runnerId, onResponded }: { runnerId?: string; onResponded?: () => void }) {
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
      const params = new URLSearchParams({ limit: "100" });
      if (runnerId) params.set("runnerId", runnerId);
      const data = await api<{ events: TriggerEvent[] }>(`/api/events?${params}`, { signal: controller.signal });
      if (current === generation.current) setEvents(data.events ?? []);
    } catch (err) {
      if (current === generation.current && !controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "Failed to load events");
      }
    }
  }, [runnerId]);

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
        <h3 className="text-sm font-semibold">{runnerId ? "Runner events" : "Event feed"}</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void load()} title="Refresh" aria-label="Refresh event feed">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && <ErrorNote message={error} />}
      {events === null && !error && <Spinner className="h-4 w-4" />}
      {events?.length === 0 && (
        <p className="text-sm text-muted-foreground">{runnerId ? "No events delivered to this runner yet." : "No events yet. Published events appear here for 30 days."}</p>
      )}
      <ScrollArea className="max-h-[60vh] pr-2">
        <div className="space-y-1.5">
          {events?.map((e) => <EventRow key={e.eventId} event={e} runnerId={runnerId} onResponded={onResponded} />)}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** GET /api/routes decorates routes whose runner the server has declared dead. */
type ListedRoute = Route & {
  runnerDead?: boolean;
  runnerDeadSince?: string;
  runtime?: TriggerRuntimeStatus;
  history?: Array<{ deliveryId: string; eventId: string; status: string; sessionId: string; spawnRouteId?: string; eventType: string; createdAt?: string; failureReason?: string }>;
};

function routeTargetLabel(target: Route["target"], sessions: Array<{ sessionId: string; sessionName?: string | null }>, runners: Array<{ runnerId: string; name?: string | null }>): string {
  if (target.kind === "session") {
    const name = sessions.find((session) => session.sessionId === target.sessionId)?.sessionName?.trim();
    return name || `Session ${target.sessionId.slice(0, 8)}`;
  }
  const runner = runners.find((item) => item.runnerId === target.spec.runnerId);
  const parts = [`Spawn on ${runner?.name?.trim() || target.spec.runnerId.slice(0, 8)}`];
  if (target.spec.cwd) parts.push(`cwd ${target.spec.cwd}`);
  if (target.spec.model) parts.push(`${target.spec.model.provider}/${target.spec.model.id}`);
  if (target.spec.autoClose) parts.push("auto-close");
  return parts.join(" · ");
}

function ManagedRouteRow({ route, schema, sessions, runners, onDeleted, onChanged, onEdit, onOpenSession }: { route: ListedRoute; schema?: Record<string, unknown>; sessions: Array<{ sessionId: string; sessionName?: string | null }>; runners: Array<{ runnerId: string; name?: string | null }>; onDeleted: (id: string) => void; onChanged: () => void; onEdit: (route: Route) => void; onOpenSession?: (sessionId: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState(route.history ?? null);
  React.useEffect(() => {
    if (route.history !== undefined) setHistory(route.history);
  }, [route.history]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [historyUnavailable, setHistoryUnavailable] = React.useState(false);
  const readOnly = isReadOnlyRoute(route);
  const sessionLabel = (sessionId: string) => sessions.find((session) => session.sessionId === sessionId)?.sessionName?.trim() || `Session ${sessionId.slice(0, 8)}`;
  const schedule = /(^|:)schedule|time:/i.test(route.eventType) || Boolean(route.runtime?.nextFireAt);
  const runtimeLabel: Record<TriggerRuntimeStatus["state"], string> = { confirmed: "Active", delivering: "Delivering", retrying: "Retrying", pending: "Starting", stale: "Stale", unknown: "Unknown" };
  const runtimeState = schedule && route.runtime ? runtimeLabel[route.runtime.state] : undefined;
  const state = route.disabled ? "Paused" : route.runnerDead ? "Runner offline" : runtimeState ?? (schedule ? "Awaiting runner acknowledgement" : "Enabled · waiting for event");
  React.useEffect(() => {
    if (!open || route.target.kind !== "session" || history !== null) return;
    let current = true;
    setHistoryLoading(true);
    api<{ deliveries?: DeliveryView[] }>(`/api/sessions/${encodeURIComponent(route.target.sessionId)}/deliveries`)
      .then((data) => {
        if (current) setHistory((data.deliveries ?? []).filter((item) => item.routeId === route.routeId).map((item) => ({ deliveryId: item.deliveryId, eventId: item.eventId, status: item.status, sessionId: item.sessionId, eventType: item.eventType, createdAt: item.createdAt, failureReason: item.failureReason })));
      })
      .catch(() => { if (current) { setHistory([]); setHistoryUnavailable(true); } })
      .finally(() => { if (current) setHistoryLoading(false); });
    return () => { current = false; };
  }, [open, route.target, route.routeId, history]);
  const mutate = async (path: string, init: RequestInit, done: () => void = onChanged) => {
    setBusy(true); setError(null);
    try { await api(path, init); done(); }
    catch (err) { setError(err instanceof Error ? err.message : "Request failed"); }
    finally { setBusy(false); }
  };
  const update = (body: Record<string, unknown>) => mutate(`/api/routes/${encodeURIComponent(route.routeId)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const test = async () => {
    const result = payloadForRouteFilters(route.filters, route.filterMode, schema);
    if (!result.ok) { setError(result.error); return; }
    setBusy(true); setError(null);
    try {
      const response = await api<{ deliveries?: Array<{ status?: string }> }>("/api/events", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: route.eventType, routeIds: [route.routeId], payload: result.payload, summary: "Test trigger" }),
      });
      if (!response.deliveries?.length) setError("Test published, but no delivery matched this trigger.");
      else if (response.deliveries.every((delivery) => delivery.status === "failed")) setError("Test matched this trigger, but delivery failed.");
      else onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "Test failed"); }
    finally { setBusy(false); }
  };
  const remove = () => mutate(`/api/routes/${encodeURIComponent(route.routeId)}`, { method: "DELETE" }, () => onDeleted(route.routeId));
  const routeTargetSessionId = route.target.kind === "session" ? route.target.sessionId : undefined;
  return <article className="rounded-md border border-border/60">
    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{route.eventType}</span>
        <Badge variant={route.disabled ? "outline" : "secondary"} className="text-[10px]">{state}</Badge>
      </button>
      {routeTargetSessionId && onOpenSession ? <button type="button" className="text-[11px] text-muted-foreground hover:underline" onClick={() => onOpenSession(routeTargetSessionId)}>{sessionLabel(routeTargetSessionId)}</button> : <span className="text-[11px] text-muted-foreground">{routeTargetLabel(route.target, sessions, runners)}</span>}
      <Badge variant="outline" className="text-[10px]">{route.deliverAs}</Badge><OriginBadge origin={route.origin} />
      <div className="flex items-center gap-1">
        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={readOnly || route.disabled || busy} onClick={() => void test()} title="Publish a matching test event to this trigger only">Test</Button>
        <Button size="icon" variant="ghost" className="size-7" disabled={readOnly || busy} onClick={() => void update({ disabled: !route.disabled })} aria-label={route.disabled ? "Resume route" : "Pause route"} title={route.disabled ? "Resume route" : "Pause route"}>{route.disabled ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}</Button>
        <Button size="icon" variant="ghost" className="size-7" disabled={readOnly || busy} onClick={() => onEdit(route)} aria-label="Edit route" title="Edit route"><Pencil className="size-3.5" /></Button>
        {confirming ? <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" disabled={busy} onClick={() => void remove()}>Delete?</Button> : <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" disabled={readOnly || busy} onClick={() => setConfirming(true)} aria-label="Delete route" title="Delete route"><Trash2 className="size-3.5" /></Button>}
      </div>
    </div>
    {open && <div className="space-y-2 border-t border-border/60 px-3 py-2 text-xs">
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <p><span className="text-muted-foreground">Destination: </span>{routeTargetLabel(route.target, sessions, runners)}</p>
        <p><span className="text-muted-foreground">Delivery: </span>{route.deliverAs === "steer" ? "Interrupt current turn" : "Queue after current turn"}</p>
        {route.target.kind === "session" && <p><span className="text-muted-foreground">If it’s offline: </span>{{ wait: "Wait without waking", wake: "Wake / resume session", fail: "Fail immediately" }[route.target.offlinePolicy ?? (route.target.wake ? "wake" : "wait")]}</p>}
        {route.runtime?.nextFireAt && <p><span className="text-muted-foreground">Next fire: </span>{new Date(route.runtime.nextFireAt).toLocaleString()}{route.runtime.timezone ? ` (${route.runtime.timezone})` : ""}</p>}
        {route.runtime?.lastAckAt && <p><span className="text-muted-foreground">Last acknowledgement: </span>{timeAgo(route.runtime.lastAckAt)}</p>}
        <p><span className="text-muted-foreground">State: </span>{route.disabled ? "Paused" : route.runnerDead ? "Runner offline" : runtimeState ?? (schedule ? "No acknowledgement reported" : "Enabled · waiting for event")}</p>
      </div>
      {route.filters?.length ? <p><span className="text-muted-foreground">Filters ({route.filterMode ?? "and"}): </span>{route.filters.map((f) => `${f.field} ${f.op ?? "eq"} ${JSON.stringify(f.value)}`).join(` ${route.filterMode === "or" ? "OR" : "AND"} `)}</p> : null}
      {route.params && Object.keys(route.params).length > 0 && <p><span className="text-muted-foreground">Parameters: </span><code className="break-all">{JSON.stringify(route.params)}</code></p>}
      {(history !== null || historyLoading || route.target.kind === "session" || route.target.kind === "spawn") && <div><p className="mb-1 text-muted-foreground">Recent deliveries</p>{historyLoading ? <Spinner className="size-3.5" /> : history?.length ? history.map((item) => <div key={item.deliveryId} className="flex flex-wrap gap-x-3 border-t border-border/40 py-1"><span>{item.status === "failed" ? `Failed${item.failureReason === "offline_policy" ? " · offline policy" : ""}` : item.status}</span><span className="font-mono">{item.eventType}</span><span>{timeAgo(item.createdAt ?? "")}</span>{onOpenSession && !item.spawnRouteId && !item.sessionId.startsWith("spawn:") ? <button type="button" className="font-mono text-muted-foreground hover:underline" onClick={() => onOpenSession(item.sessionId)}>{sessionLabel(item.sessionId)}</button> : <span className="font-mono text-muted-foreground">{sessionLabel(item.sessionId)}</span>}</div>) : <p>{historyUnavailable ? "Delivery history unavailable." : history === null ? "No delivery history reported." : "No delivery history."}</p>}</div>}
    </div>}
    {error && <p className="px-3 pb-2 text-xs text-destructive" role="alert">{error}</p>}
  </article>;
}

function RoutesTab({ sessionId, runnerId, sessions = [], runners = [], onMutated, onOpenSession }: { sessionId?: string; runnerId?: string; sessions?: Array<{ sessionId: string; sessionName?: string | null; runnerId?: string | null }>; runners?: Array<{ runnerId: string; name?: string | null }>; onMutated?: () => void; onOpenSession?: (sessionId: string) => void }) {
  const [routes, setRoutes] = React.useState<ListedRoute[] | null>(null);
  const [catalog, setCatalog] = React.useState<ServiceTriggerDef[]>([]);
  const [editing, setEditing] = React.useState<Route | null>(null);
  const [formOpen, setFormOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [eventFilter, setEventFilter] = React.useState("");
  const [stateFilter, setStateFilter] = React.useState("");
  const [destinationFilter, setDestinationFilter] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ routes: ListedRoute[] }>("/api/routes");
      let listed = data.routes ?? [];
      if (runnerId) {
        listed = listed.filter((route) => route.target.kind === "session"
          ? route.target.runnerId === runnerId
          : route.target.spec.runnerId === runnerId);
        try {
          const listeners = await api<{ listeners?: Array<{ listenerId?: string; runtime?: TriggerRuntimeStatus; history?: ListedRoute["history"] }> }>(`/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners`);
          const byId = new Map((listeners.listeners ?? []).filter((item) => item.listenerId).map((item) => [item.listenerId!, item]));
          listed = listed.map((route) => {
            const listener = byId.get(route.routeId);
            return listener ? { ...route, runtime: listener.runtime ?? route.runtime, history: listener.history ?? route.history } : route;
          });
        } catch { /* The unified route list still works if legacy listener metadata is unavailable. */ }
      }
      setRoutes(listed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load routes");
    }
  }, [runnerId]);

  React.useEffect(() => { void load(); }, [load]);

  React.useEffect(() => {
    if (!runnerId) return;
    let cancelled = false;
    api<{ triggerDefs: ServiceTriggerDef[] }>(`/api/runners/${encodeURIComponent(runnerId)}/triggers`)
      .then((data) => {
        if (cancelled) return;
        const schedules: ServiceTriggerDef[] = [
          { type: "time:cron", label: "Cron schedule", params: [{ name: "cron", label: "Cron expression", type: "string", required: true }, { name: "message", label: "Prompt", type: "string" }] },
          { type: "time:at", label: "Scheduled time", params: [{ name: "at", label: "Date/time", type: "string", required: true }, { name: "message", label: "Prompt", type: "string" }] },
          { type: "time:timer_fired", label: "Timer", params: [{ name: "duration", label: "Duration", type: "string", required: true }, { name: "message", label: "Prompt", type: "string" }] },
        ];
        const defs = data.triggerDefs ?? [];
        setCatalog([...defs, ...schedules.filter((schedule) => !defs.some((def) => def.type === schedule.type))]);
      })
      .catch(() => { /* free-text fallback */ });
    return () => { cancelled = true; };
  }, [runnerId]);

  const afterMutation = () => {
    setEditing(null);
    setFormOpen(false);
    void load();
    onMutated?.();
  };
  const destinationOptions = React.useMemo(() => {
    const options = new Map<string, string>();
    for (const route of routes ?? []) {
      const target = route.target;
      const id = target.kind === "session" ? target.sessionId : target.spec.runnerId;
      options.set(`${target.kind}:${id}`, routeTargetLabel(target, sessions ?? [], runners ?? []));
    }
    return [...options.entries()];
  }, [routes, sessions, runners]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Triggers</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void load()} title="Refresh triggers" aria-label="Refresh triggers">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        {!formOpen && <Button size="sm" className="ml-auto h-8" onClick={() => { setEditing(null); setFormOpen(true); }}>New trigger</Button>}
      </div>
      {formOpen && <RouteForm
        catalog={catalog}
        targetSessionId={sessionId}
        sessions={sessions}
        runners={runners}
        fixedRunnerId={runnerId}
        editing={editing}
        onDone={afterMutation}
        onCancel={() => { setEditing(null); setFormOpen(false); }}
      />}
      {editing && (
        <p className="text-[11px] text-muted-foreground">Editing <span className="font-mono">{editing.eventType}</span> — save or cancel to add a new route.</p>
      )}
      {error && <ErrorNote message={error} />}
      {routes === null && !error && <Spinner className="h-4 w-4" />}
      {routes?.length === 0 && (
        <p className="text-sm text-muted-foreground">No triggers yet. Select New trigger to create one.</p>
      )}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" /><Input aria-label="Search triggers" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search triggers…" className="h-8 pl-8 text-xs" /></div>
        <select aria-label="Filter by source or event" value={eventFilter} onChange={(e) => setEventFilter(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs"><option value="">All events</option>{Array.from(new Set((routes ?? []).map((r) => r.eventType))).sort().map((type) => <option key={type} value={type}>{type}</option>)}</select>
        <select aria-label="Filter by runtime state" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs"><option value="">All states</option><option value="enabled">Enabled</option><option value="paused">Paused</option><option value="waiting">Waiting / unacknowledged</option><option value="offline">Runner offline</option></select>
        <select aria-label="Filter by destination" value={destinationFilter} onChange={(e) => setDestinationFilter(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-xs"><option value="">All destinations</option><option value="session">Existing sessions</option><option value="spawn">Spawn sessions</option>{destinationOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      </div>
      <ScrollArea className="max-h-[55vh] pr-2">
        <div className="space-y-1.5">
          {routes?.filter((r) => {
            const destination = r.target.kind === "session" ? r.target.sessionId : r.target.spec.runnerId;
            const targetLabel = routeTargetLabel(r.target, sessions ?? [], runners ?? []);
            const label = `${r.eventType} ${targetLabel} ${r.origin} ${r.disabled ? "paused" : "enabled"}`.toLowerCase();
            const destinationKey = `${r.target.kind}:${destination}`;
            return label.includes(query.toLowerCase()) && (!eventFilter || r.eventType === eventFilter)
              && (!destinationFilter || destinationFilter === r.target.kind || destinationKey === destinationFilter)
              && (!stateFilter || (stateFilter === "enabled" ? !r.disabled && !r.runnerDead : stateFilter === "paused" ? !!r.disabled : stateFilter === "offline" ? !!r.runnerDead : !r.disabled && !r.runnerDead && (!r.runtime || r.runtime.state === "unknown" || r.runtime.state === "pending")));
          }).map((r) => (
            <ManagedRouteRow
              key={r.routeId}
              route={r}
              schema={catalog.find((def) => def.type === r.eventType)?.schema}
              sessions={sessions ?? []}
              runners={runners ?? []}
              onDeleted={(id) => { setRoutes((prev) => prev?.filter((x) => x.routeId !== id) ?? prev); onMutated?.(); }}
              onChanged={afterMutation}
              onEdit={(route) => { setEditing(route); setFormOpen(true); }}
              onOpenSession={onOpenSession}
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
  runnerId,
  sessions,
  runners,
  onOpenManager,
  onOpenSession,
}: {
  bare?: boolean;
  sessionId?: string;
  runnerId?: string;
  sessions?: Array<{ sessionId: string; sessionName?: string | null; runnerId?: string | null }>;
  runners?: Array<{ runnerId: string; name?: string | null }>;
  viewerSocket?: unknown;
  onOpenManager?: () => void;
  onOpenSession?: (sessionId: string) => void;
  /** useTriggerCount().refresh — called after every mutation so badges update. */
  onBadgeRefresh?: () => void;
}) {
  const [tab, setTab] = React.useState<"events" | "deliveries">(sessionId ? "deliveries" : "events");
  const tabs = sessionId ? ([["deliveries", "Deliveries"]] as const) : ([["events", "Event feed"]] as const);

  const [runnerTab, setRunnerTab] = React.useState<"triggers" | "events">("triggers");

  const body = runnerId ? (
    <div className="space-y-3">
      <div role="tablist" aria-label="Runner triggers and events" className="flex items-center gap-1 rounded-lg bg-muted p-1 w-fit">
        {([["triggers", "Triggers"], ["events", "Events"]] as const).map(([tabId, label]) => (
          <button key={tabId} type="button" role="tab" aria-selected={runnerTab === tabId} onClick={() => setRunnerTab(tabId)} className={cn("rounded-md px-3 py-1 text-xs font-medium transition-colors", runnerTab === tabId ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            {label}
          </button>
        ))}
      </div>
      {runnerTab === "triggers"
        ? <RoutesTab runnerId={runnerId} sessions={sessions} runners={runners} onMutated={onBadgeRefresh} onOpenSession={onOpenSession} />
        : <EventsTab key={runnerId} runnerId={runnerId} onResponded={onBadgeRefresh} />}
    </div>
  ) : (
    <div className="space-y-4">
      {sessionId && onOpenManager && <Button variant="outline" size="sm" onClick={onOpenManager}>Open runner-wide trigger manager</Button>}
      <div role="tablist" aria-label="Events and deliveries views" className="flex items-center gap-1 rounded-lg bg-muted p-1 w-fit">
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
          <DeliveriesTab key={sessionId} sessionId={sessionId} viewerSocket={viewerSocket} onResponded={onBadgeRefresh} />
        ) : (
          <EventsTab onResponded={onBadgeRefresh} />
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