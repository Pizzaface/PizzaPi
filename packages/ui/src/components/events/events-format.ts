/**
 * Unified trigger system (ADR-0002) — pure helpers for the Events/Routes
 * UI: formatting for the feeds plus the shared `api()` fetch helper. Kept
 * free of React imports so it stays unit-testable without component mocks.
 */

import type { Delivery, DeliveryStatus, JsonValue, Route, RouteTarget, ServiceTriggerParamDef, SourceIdentity, TriggerEvent } from "@pizzapi/protocol";

/** Shared fetch helper: JSON in/out, throws Error(message) on !ok. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Chip metadata per delivery status. Tailwind classes for the badge. */
export const DELIVERY_STATUS_META: Record<DeliveryStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30" },
  inflight: { label: "In flight", className: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30" },
  delivered: { label: "Delivered", className: "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30" },
  responded: { label: "Responded", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30" },
  escalated: { label: "Escalated", className: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30" },
  expired: { label: "Expired", className: "bg-muted text-muted-foreground border-border" },
};

/** Human label for a route target. */
export function summarizeRouteTarget(target: RouteTarget): string {
  if (target.kind === "session") {
    const wake = target.wake ? " · wake" : "";
    return `Session ${target.sessionId.slice(0, 8)}${wake}`;
  }
  const parts = [`Spawn on ${target.spec.runnerId.slice(0, 8)}`];
  if (target.spec.cwd) parts.push(`cwd ${target.spec.cwd}`);
  if (target.spec.model) parts.push(`${target.spec.model.provider}/${target.spec.model.id}`);
  if (target.spec.autoClose) parts.push("auto-close");
  return parts.join(" · ");
}

/** True when the UI must treat the route as read-only (config file owns it). */
export function isReadOnlyRoute(route: Route): boolean {
  return route.origin === "config";
}

/** Short "who fired this" label for the feed. */
export function eventSourceLabel(source: SourceIdentity): string {
  if (source.kind === "session") return `session:${(source.id ?? "").slice(0, 8)}`;
  return `${source.kind}:${source.id}`;
}

/** Feed row title: summary wins, else the raw type. */
export function eventTitle(event: TriggerEvent): string {
  return event.summary || event.type;
}

/** Whether a delivery can be answered from the UI. */
export function isRespondableDelivery(delivery: Delivery): boolean {
  return delivery.status === "pending" || delivery.status === "delivered" || delivery.status === "escalated";
}

/**
 * Whether to render respond controls. The server-stamped `respondable`
 * view field (from the Event's ResponseContract) wins; the status heuristic
 * only covers an older server that does not stamp the field yet.
 */
export function canRespond(delivery: Delivery & { respondable?: boolean }): boolean {
  if (delivery.respondable !== undefined) return delivery.respondable;
  return isRespondableDelivery(delivery) && !delivery.response;
}

/** Compact relative time — minutes/hours/days, absolute date past a week. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ── Route form helpers (catalog-driven create/edit) ─────────────────────────

/** Render a param default into an input-friendly string. */
export function formatParamValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Parse raw form input into the param's declared type. */
export function parseParamInput(
  param: ServiceTriggerParamDef,
  raw: string | string[],
): { ok: true; value: JsonValue | undefined } | { ok: false; error: string } {
  if (param.multiselect && param.enum) {
    const selected = Array.isArray(raw) ? raw : [];
    if (selected.length === 0 && param.required) {
      return { ok: false, error: `"${param.label}" requires at least one selection` };
    }
    if (selected.length === 0) return { ok: true, value: undefined };
    if (param.type === "number") return { ok: true, value: selected.map(Number).filter((n) => !Number.isNaN(n)) };
    if (param.type === "boolean") return { ok: true, value: selected.map((v) => v === "true") };
    return { ok: true, value: selected };
  }

  const str = (typeof raw === "string" ? raw : "").trim();
  if (!str && param.required) return { ok: false, error: `"${param.label}" is required` };
  if (!str) return { ok: true, value: undefined };

  if (param.type === "json") {
    try {
      return { ok: true, value: JSON.parse(str) as JsonValue };
    } catch {
      return { ok: false, error: `"${param.label}" must be valid JSON` };
    }
  }
  if (param.type === "number") {
    const num = Number(str);
    if (Number.isNaN(num)) return { ok: false, error: `"${param.label}" must be a number` };
    return { ok: true, value: num };
  }
  if (param.type === "boolean") return { ok: true, value: str === "true" };
  return { ok: true, value: str };
}

/**
 * Parse a filter row's raw value using the payload schema's declared type
 * when known. Unknown fields stay strings — never guess a conversion.
 */
export function parseFilterValue(raw: string, propType?: string): string | number | boolean {
  const str = raw.trim();
  if (propType === "number") {
    const num = Number(str);
    return Number.isNaN(num) ? str : num;
  }
  if (propType === "boolean") return str === "true";
  return str;
}