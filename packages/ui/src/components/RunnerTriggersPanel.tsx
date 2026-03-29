/**
 * RunnerTriggersPanel — runner-level trigger catalog with auto-spawn listeners.
 *
 * Shows available trigger types from runner services grouped by service
 * prefix as collapsible accordions. Each trigger type has a subscribe toggle
 * that creates an auto-spawn listener — when that trigger fires, the server
 * spawns a new session and delivers the trigger into it.
 *
 * Triggers with configurable params show an inline form (dropdowns, checkboxes,
 * text inputs) before subscribing, so listeners can filter which events spawn.
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ServiceTriggerDef, ServiceTriggerParamDef } from "@pizzapi/protocol";

// ── Helpers ────────────────────────────────────────────────────────────────

function servicePrefix(type: string): string {
  const idx = type.indexOf(":");
  return idx > 0 ? type.slice(0, idx) : type;
}

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
    if (existing) existing.push(def);
    else map.set(svc, [def]);
  }
  return Array.from(map.entries()).map(([service, d]) => ({ service, defs: d }));
}

// ── Param Form ─────────────────────────────────────────────────────────────

interface ParamFormProps {
  params: ServiceTriggerParamDef[];
  values: Record<string, string | string[]>;
  onChange: (values: Record<string, string | string[]>) => void;
  error: string | null;
  onSubmit: () => void;
  onCancel: () => void;
  isPending: boolean;
}

function ParamForm({ params, values, onChange, error, onSubmit, onCancel, isPending }: ParamFormProps) {
  const updateValue = (name: string, value: string | string[]) => {
    onChange({ ...values, [name]: value });
  };

  return (
    <div className="mt-2 rounded border border-violet-500/20 bg-violet-950/10 p-2.5 space-y-2">
      <div className="text-[11px] font-medium text-violet-300/80">Configure listener params</div>
      {params.map((p) => {
        const currentVal = values[p.name];
        const selectedArr = Array.isArray(currentVal) ? currentVal : [];

        return (
          <div key={p.name} className="flex items-start gap-2">
            <label
              className="text-[11px] text-muted-foreground/70 w-24 shrink-0 truncate pt-0.5"
              title={p.description ?? p.name}
            >
              {p.label}{p.required ? <span className="text-amber-400">*</span> : ""}
            </label>

            {/* Multiselect: checkboxes */}
            {p.multiselect && p.enum ? (
              <div className="flex-1 flex flex-wrap gap-x-3 gap-y-1">
                {p.enum.map((opt) => {
                  const optStr = String(opt);
                  const checked = selectedArr.includes(optStr);
                  return (
                    <label key={optStr} className="flex items-center gap-1 cursor-pointer text-[11px] text-foreground/80">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = checked
                            ? selectedArr.filter(v => v !== optStr)
                            : [...selectedArr, optStr];
                          updateValue(p.name, next);
                        }}
                        className="accent-primary size-3"
                      />
                      {optStr}
                    </label>
                  );
                })}
              </div>

            /* Enum single select: dropdown */
            ) : p.enum ? (
              <select
                value={typeof currentVal === "string" ? currentVal : ""}
                onChange={(e) => updateValue(p.name, e.target.value)}
                className="flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
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
                onChange={(e) => updateValue(p.name, e.target.value)}
                className="flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
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
                onChange={(e) => updateValue(p.name, e.target.value)}
                className="flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
              />
            )}
          </div>
        );
      })}

      {error && <p className="text-[10px] text-destructive">{error}</p>}

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="outline" className="h-6 text-[11px] px-2" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" className="h-6 text-[11px] px-2" disabled={isPending} onClick={onSubmit}>
          {isPending ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
          Subscribe
        </Button>
      </div>
    </div>
  );
}

// ── Trigger Item ───────────────────────────────────────────────────────────

interface TriggerItemProps {
  def: ServiceTriggerDef;
  isListening: boolean;
  isPending: boolean;
  listenerParams?: Record<string, unknown>;
  paramFormOpen: boolean;
  paramValues: Record<string, string | string[]>;
  paramError: string | null;
  onToggle: (def: ServiceTriggerDef, isListening: boolean) => void;
  onParamValuesChange: (values: Record<string, string | string[]>) => void;
  onParamSubmit: (def: ServiceTriggerDef) => void;
  onParamCancel: () => void;
}

function TriggerItem({
  def, isListening, isPending, listenerParams,
  paramFormOpen, paramValues, paramError,
  onToggle, onParamValuesChange, onParamSubmit, onParamCancel,
}: TriggerItemProps) {
  const hasParams = def.params && def.params.length > 0;

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          {/* Type + label + badges */}
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
            {hasParams && !isListening && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-violet-500/30 text-violet-400/70 shrink-0">
                configurable
              </Badge>
            )}
          </div>

          {/* Description */}
          {def.description && (
            <p className="text-[11px] text-muted-foreground/70 mt-0.5 leading-snug">
              {def.description}
            </p>
          )}

          {/* Current listener params (when subscribed) */}
          {isListening && listenerParams && Object.keys(listenerParams).length > 0 && (
            <div className="mt-1 flex items-center gap-1 flex-wrap">
              {Object.entries(listenerParams).map(([k, v]) => (
                <Badge key={k} variant="outline" className="px-1 py-0 text-[9px] h-3.5 border-emerald-500/20 text-emerald-400/60">
                  {k}={Array.isArray(v) ? v.map(String).join(", ") : String(v)}
                </Badge>
              ))}
            </div>
          )}

          {/* Param definitions (when not subscribed and form not open) */}
          {hasParams && !isListening && !paramFormOpen && (
            <div className="mt-1.5 space-y-0.5">
              {def.params!.map((p) => (
                <div key={p.name} className="text-[10px] text-muted-foreground/60">
                  <span className="font-mono text-foreground/70">{p.name}</span>
                  <span className="text-muted-foreground/40">: {p.type}</span>
                  {p.required && <span className="text-amber-400/60 ml-1">required</span>}
                  {p.multiselect && <span className="text-violet-400/60 ml-1">multiselect</span>}
                  {p.enum && (
                    <span className="text-muted-foreground/40 ml-1">
                      {"{" + p.enum.map(String).join(", ") + "}"}
                    </span>
                  )}
                  {p.description && <span className="ml-1">— {p.description}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Toggle button */}
        <button
          type="button"
          onClick={() => onToggle(def, isListening)}
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

      {/* Inline param form */}
      {paramFormOpen && hasParams && (
        <ParamForm
          params={def.params!}
          values={paramValues}
          onChange={onParamValuesChange}
          error={paramError}
          onSubmit={() => onParamSubmit(def)}
          onCancel={onParamCancel}
          isPending={isPending}
        />
      )}
    </div>
  );
}

// ── Service Accordion ──────────────────────────────────────────────────────

interface ServiceAccordionProps {
  group: ServiceGroup;
  listenedTypes: Set<string>;
  listenerParamsMap: Map<string, Record<string, unknown>>;
  pendingTypes: Set<string>;
  paramFormOpen: string | null;
  paramValues: Record<string, Record<string, string | string[]>>;
  paramError: string | null;
  onToggle: (def: ServiceTriggerDef, isListening: boolean) => void;
  onParamValuesChange: (triggerType: string, values: Record<string, string | string[]>) => void;
  onParamSubmit: (def: ServiceTriggerDef) => void;
  onParamCancel: () => void;
}

function ServiceAccordion({
  group, listenedTypes, listenerParamsMap, pendingTypes,
  paramFormOpen, paramValues, paramError,
  onToggle, onParamValuesChange, onParamSubmit, onParamCancel,
}: ServiceAccordionProps) {
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
          {group.defs.map((def) => (
            <TriggerItem
              key={def.type}
              def={def}
              isListening={listenedTypes.has(def.type)}
              isPending={pendingTypes.has(def.type)}
              listenerParams={listenerParamsMap.get(def.type)}
              paramFormOpen={paramFormOpen === def.type}
              paramValues={paramValues[def.type] ?? {}}
              paramError={paramFormOpen === def.type ? paramError : null}
              onToggle={onToggle}
              onParamValuesChange={(vals) => onParamValuesChange(def.type, vals)}
              onParamSubmit={onParamSubmit}
              onParamCancel={onParamCancel}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────────

export interface RunnerTriggersPanelProps {
  runnerId: string;
  triggerDefs?: ServiceTriggerDef[];
}

interface ListenerInfo {
  triggerType: string;
  prompt?: string;
  cwd?: string;
  params?: Record<string, unknown>;
  createdAt: string;
}

export function RunnerTriggersPanel({ runnerId, triggerDefs: propDefs }: RunnerTriggersPanelProps) {
  const [fetchedDefs, setFetchedDefs] = React.useState<ServiceTriggerDef[]>([]);
  const [listeners, setListeners] = React.useState<ListenerInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingTypes, setPendingTypes] = React.useState<Set<string>>(new Set());

  // Param form state
  const [paramFormOpen, setParamFormOpen] = React.useState<string | null>(null);
  const [paramValues, setParamValues] = React.useState<Record<string, Record<string, string | string[]>>>({});
  const [paramError, setParamError] = React.useState<string | null>(null);

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
  const listenerParamsMap = React.useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const l of listeners) {
      if (l.params && Object.keys(l.params).length > 0) {
        map.set(l.triggerType, l.params);
      }
    }
    return map;
  }, [listeners]);

  // Find trigger def by type (for param validation)
  const defsByType = React.useMemo(() => {
    const map = new Map<string, ServiceTriggerDef>();
    for (const d of triggerDefs) map.set(d.type, d);
    return map;
  }, [triggerDefs]);

  const handleToggle = React.useCallback((def: ServiceTriggerDef, isListening: boolean) => {
    if (isListening) {
      // Unsubscribe directly
      setPendingTypes((prev) => new Set([...prev, def.type]));
      void (async () => {
        try {
          await fetch(
            `/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners/${encodeURIComponent(def.type)}`,
            { method: "DELETE", credentials: "include" },
          );
          setListeners((prev) => prev.filter((l) => l.triggerType !== def.type));
        } catch { /* best-effort */ } finally {
          setPendingTypes((prev) => { const n = new Set(prev); n.delete(def.type); return n; });
        }
      })();
    } else if (def.params && def.params.length > 0) {
      // Open param form
      setParamFormOpen(def.type);
      setParamError(null);
      // Pre-fill defaults
      const defaults: Record<string, string | string[]> = {};
      for (const p of def.params) {
        if (p.multiselect) defaults[p.name] = [];
        else if (p.default !== undefined) defaults[p.name] = String(p.default);
      }
      setParamValues((prev) => ({ ...prev, [def.type]: { ...defaults, ...prev[def.type] } }));
    } else {
      // No params — subscribe directly
      setPendingTypes((prev) => new Set([...prev, def.type]));
      void (async () => {
        try {
          await fetch(
            `/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners`,
            {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ triggerType: def.type }),
            },
          );
          setListeners((prev) => [...prev, { triggerType: def.type, createdAt: new Date().toISOString() }]);
        } catch { /* best-effort */ } finally {
          setPendingTypes((prev) => { const n = new Set(prev); n.delete(def.type); return n; });
        }
      })();
    }
  }, [runnerId]);

  const handleParamSubmit = React.useCallback((def: ServiceTriggerDef) => {
    const vals = paramValues[def.type] ?? {};
    const params: Record<string, unknown> = {};
    for (const p of (def.params ?? [])) {
      const raw = vals[p.name];

      // Multiselect
      if (p.multiselect && p.enum) {
        const selected = Array.isArray(raw) ? raw : [];
        if (selected.length === 0 && p.required) {
          setParamError(`'${p.label}' requires at least one selection`);
          return;
        }
        if (selected.length === 0) continue;
        if (p.type === "number") params[p.name] = selected.map(Number).filter(n => !isNaN(n));
        else if (p.type === "boolean") params[p.name] = selected.map(v => v === "true");
        else params[p.name] = selected;
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
        if (isNaN(num)) { setParamError(`'${p.label}' must be a number`); return; }
        params[p.name] = num;
      } else if (p.type === "boolean") {
        params[p.name] = str === "true";
      } else {
        params[p.name] = str;
      }
    }

    setPendingTypes((prev) => new Set([...prev, def.type]));
    setParamError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              triggerType: def.type,
              ...(Object.keys(params).length > 0 ? { params } : {}),
            }),
          },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          setParamError(data.error ?? `HTTP ${res.status}`);
          return;
        }
        setParamFormOpen(null);
        setListeners((prev) => [
          ...prev.filter(l => l.triggerType !== def.type),
          { triggerType: def.type, params: Object.keys(params).length > 0 ? params : undefined, createdAt: new Date().toISOString() },
        ]);
      } catch { /* best-effort */ } finally {
        setPendingTypes((prev) => { const n = new Set(prev); n.delete(def.type); return n; });
      }
    })();
  }, [runnerId, paramValues]);

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
          listenerParamsMap={listenerParamsMap}
          pendingTypes={pendingTypes}
          paramFormOpen={paramFormOpen}
          paramValues={paramValues}
          paramError={paramError}
          onToggle={handleToggle}
          onParamValuesChange={(type, vals) => setParamValues((prev) => ({ ...prev, [type]: vals }))}
          onParamSubmit={handleParamSubmit}
          onParamCancel={() => { setParamFormOpen(null); setParamError(null); }}
        />
      ))}
    </div>
  );
}
