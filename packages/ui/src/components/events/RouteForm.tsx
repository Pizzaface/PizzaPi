/**
 * RouteForm — catalog-driven route creation and editing (ADR-0002).
 *
 * Restores the TriggersPanel flow: pick a trigger type from the runner's
 * service catalog (free-text fallback for unknown types, validated with
 * isValidEventType), fill params with typed inputs generated from the
 * trigger def (string/number/boolean/enum/multiselect/JSON), add payload
 * filters (field/op/value), and submit create (POST /api/routes) or edit
 * (PUT /api/routes/:id). Config-origin routes never reach this form — the
 * caller keeps them read-only.
 */

import * as React from "react";
import {
  isValidEventType,
  type JsonValue,
  type Route,
  type RouteInput,
  type ServiceTriggerDef,
  type ServiceTriggerParamDef,
} from "@pizzapi/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Plus, Trash2 } from "lucide-react";
import {
  api,
  formatParamValue,
  parseFilterValue,
  parseParamInput,
  summarizeRouteTarget,
} from "./events-format";

const CUSTOM_OPTION = "__custom__";

interface FilterRow {
  field: string;
  op: "eq" | "contains";
  value: string;
  caseSensitive: boolean;
}

interface RouteFormProps {
  /** Trigger defs from the session's runner catalog (empty = free-text only). */
  catalog: ServiceTriggerDef[];
  /** Session-scoped mode: the route targets this session (locked). */
  targetSessionId?: string;
  /** Route being edited; null = create. */
  editing?: Route | null;
  onDone: () => void;
  onCancel: () => void;
}

/** Parameter defaults for a def, or the route's current values when editing. */
function initialParamValues(def: ServiceTriggerDef | undefined, route: Route | null): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  const defsByName = new Map((def?.params ?? []).map((p) => [p.name, p]));
  if (route?.params) {
    for (const [name, value] of Object.entries(route.params)) {
      const paramDef = defsByName.get(name);
      values[name] = paramDef?.multiselect && Array.isArray(value)
        ? value.map(String)
        : formatParamValue(value);
    }
  }
  for (const param of def?.params ?? []) {
    if (values[param.name] !== undefined) continue;
    values[param.name] = param.multiselect
      ? []
      : param.default !== undefined
        ? formatParamValue(param.default)
        : "";
  }
  return values;
}

function initialFilterRows(route: Route | null): FilterRow[] {
  return (route?.filters ?? []).map((filter) => ({
    field: filter.field,
    op: filter.op ?? "eq",
    value: Array.isArray(filter.value) ? filter.value.join(",") : String(filter.value),
    caseSensitive: filter.caseSensitive === true,
  }));
}

export function RouteForm({ catalog, targetSessionId, editing = null, onDone, onCancel }: RouteFormProps) {
  const [eventType, setEventType] = React.useState(editing?.eventType ?? "");
  const [params, setParams] = React.useState<Record<string, string | string[]>>({});
  const [filters, setFilters] = React.useState<FilterRow[]>([]);
  const [filterMode, setFilterMode] = React.useState<Route["filterMode"]>(editing?.filterMode ?? "and");
  const [deliverAs, setDeliverAs] = React.useState<RouteInput["deliverAs"]>(editing?.deliverAs ?? "followUp");
  const [sessionIdInput, setSessionIdInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const def = React.useMemo(() => catalog.find((d) => d.type === eventType), [catalog, eventType]);
  const typeInCatalog = def !== undefined || eventType === "";
  const schemaProps = (def?.schema as { properties?: Record<string, { type?: string; enum?: unknown[] }> } | undefined)
    ?.properties ?? {};

  // Re-seed param/filter state whenever the effective type or edit target changes.
  React.useEffect(() => {
    setParams(initialParamValues(def, editing));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventType, editing?.routeId]);

  React.useEffect(() => {
    setFilters(initialFilterRows(editing));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.routeId]);

  // The form instance persists across create↔edit switches (RoutesTab mounts one
  // RouteForm). useState initializers never re-run, so sync the editing target's
  // type/delivery/mode — and reset them when the edit is cleared.
  React.useEffect(() => {
    if (editing) {
      setEventType(editing.eventType);
      setDeliverAs(editing.deliverAs);
      setFilterMode(editing.filterMode ?? "and");
    } else {
      setEventType("");
      setDeliverAs("followUp");
      setFilterMode("and");
    }
  }, [editing]);

  const submit = async () => {
    setError(null);
    if (!isValidEventType(eventType)) {
      setError("Event type must be lowercase and namespaced (e.g. github:pr_comment).");
      return;
    }
    const targetSession = editing
      ? editing.target.kind === "session" ? editing.target.sessionId : undefined
      : targetSessionId ?? sessionIdInput.trim();
    if (!editing && !targetSession) {
      setError("A target session id is required.");
      return;
    }

    const parsedParams: Record<string, JsonValue> = {};
    const defNames = new Set((def?.params ?? []).map((p) => p.name));
    // Params the catalog doesn't declare are not form-editable — preserve them
    // on edit (PUT replaces the whole params object).
    if (editing?.params) {
      for (const [name, value] of Object.entries(editing.params)) {
        if (!defNames.has(name)) parsedParams[name] = value;
      }
    }
    for (const param of def?.params ?? []) {
      const result = parseParamInput(param, params[param.name] ?? (param.multiselect ? [] : ""));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.value !== undefined) parsedParams[param.name] = result.value;
    }

    const parsedFilters = filters
      .filter((filter) => filter.field.trim() !== "" && filter.value.trim() !== "")
      .map((filter) => ({
        field: filter.field.trim(),
        op: filter.op,
        value: parseFilterValue(filter.value, schemaProps[filter.field.trim()]?.type),
        ...(filter.caseSensitive ? { caseSensitive: true } : {}),
      }));

    setBusy(true);
    try {
      if (editing) {
        const body: Record<string, unknown> = {
          eventType,
          deliverAs,
          filters: parsedFilters,
          filterMode: parsedFilters.length > 1 ? filterMode : undefined,
        };
        // Without a catalog def the form shows no params — preserve the route's
        // existing values instead of wiping them.
        if (def) body.params = parsedParams;
        await api(`/api/routes/${encodeURIComponent(editing.routeId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        await api("/api/routes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            eventType,
            target: { kind: "session", sessionId: targetSession },
            deliverAs,
            ...(Object.keys(parsedParams).length > 0 ? { params: parsedParams } : {}),
            ...(parsedFilters.length > 0 ? { filters: parsedFilters } : {}),
            ...(parsedFilters.length > 1 ? { filterMode } : {}),
            origin: "ui",
          }),
        });
        setEventType("");
        setSessionIdInput("");
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const eventTypeId = React.useId();
  const targetId = React.useId();
  const deliverAsId = React.useId();
  const customType = !typeInCatalog || catalog.length === 0;

  return (
    <div className="rounded-md border border-border/60 px-3 py-2.5 space-y-2.5">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold">{editing ? "Edit route" : "New route"}</h4>
        {editing && (
          <span className="truncate text-[11px] text-muted-foreground">{summarizeRouteTarget(editing.target)}</span>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-44 flex-1">
          <Label htmlFor={eventTypeId} className="text-[11px] text-muted-foreground">Event type</Label>
          {catalog.length > 0 ? (
            <select
              id={eventTypeId}
              value={typeInCatalog ? eventType : CUSTOM_OPTION}
              onChange={(e) => {
                const next = e.target.value;
                if (next === CUSTOM_OPTION) {
                  setEventType("");
                } else {
                  setEventType(next);
                }
              }}
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {!typeInCatalog && (
                <option value={CUSTOM_OPTION}>Custom type…</option>
              )}
              {/* Placeholder mirrors the empty state so the visible selection
                  never diverges from React state (params render from state). */}
              {(eventType === "" && !editing) && (
                <option value="" disabled>— select a trigger type —</option>
              )}
              {Object.entries(groupByService(catalog)).map(([service, defs]) => (
                <optgroup key={service} label={service}>
                  {defs.map((d) => (
                    <option key={d.type} value={d.type}>{d.label !== d.type ? `${d.label} (${d.type})` : d.type}</option>
                  ))}
                </optgroup>
              ))}
              {typeInCatalog && <option value={CUSTOM_OPTION}>Custom type…</option>}
            </select>
          ) : null}
          {customType && (
            <Input
              id={catalog.length > 0 ? undefined : eventTypeId}
              aria-label={catalog.length > 0 ? "Custom event type" : undefined}
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
              placeholder="github:pr_comment"
              aria-describedby={eventType !== "" && !isValidEventType(eventType) ? `${eventTypeId}-hint` : undefined}
              className="mt-1 h-8 text-xs"
            />
          )}
          {eventType !== "" && !isValidEventType(eventType) && (
            <p id={`${eventTypeId}-hint`} className="text-[11px] text-destructive">
              Must be lowercase and namespaced (namespace:name).
            </p>
          )}
        </div>

        {!editing && (
          <div className="min-w-44 flex-1">
            {targetSessionId ? (
              <>
                <Label htmlFor={targetId} className="text-[11px] text-muted-foreground">Target session</Label>
                <Input id={targetId} value={targetSessionId} readOnly disabled className="mt-0 h-8 font-mono text-[11px]" />
              </>
            ) : (
              <>
                <Label htmlFor={targetId} className="text-[11px] text-muted-foreground">Target session id</Label>
                <Input
                  id={targetId}
                  value={sessionIdInput}
                  onChange={(e) => setSessionIdInput(e.target.value)}
                  placeholder="a1b2c3d4-…"
                  className="mt-0 h-8 text-xs"
                />
              </>
            )}
          </div>
        )}

        <div className="flex flex-col">
          <Label htmlFor={deliverAsId} className="text-[11px] text-muted-foreground">Deliver as</Label>
          <Button
            id={deliverAsId}
            variant="outline"
            size="sm"
            className="h-8 px-2 text-xs"
            aria-pressed={deliverAs === "steer"}
            onClick={() => setDeliverAs((d) => (d === "steer" ? "followUp" : "steer"))}
            title="steer interrupts the current turn; followUp queues after it"
          >
            {deliverAs}
          </Button>
        </div>

        <div className="flex gap-1.5">
          <Button size="sm" className="h-8 gap-1 px-2 text-xs" disabled={busy} onClick={() => void submit()}>
            {busy ? <Spinner className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
            {editing ? "Save" : "Add route"}
          </Button>
          {editing && (
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {(def?.params?.length ?? 0) > 0 && (
        <fieldset className="space-y-1.5 rounded-md border border-border/40 px-2.5 py-2">
          <legend className="px-1 text-[11px] font-medium text-muted-foreground">Parameters</legend>
          {def!.params!.map((param) => (
            <ParamField key={param.name} param={param} value={params[param.name]} onChange={(next) => setParams((prev) => ({ ...prev, [param.name]: next }))} />
          ))}
        </fieldset>
      )}

      <fieldset className="space-y-1.5 rounded-md border border-border/40 px-2.5 py-2">
        <legend className="flex items-center gap-2 px-1 text-[11px] font-medium text-muted-foreground">
          Payload filters
          {filters.length > 1 && (
            <select
              aria-label="Filter combine mode"
              value={filterMode}
              onChange={(e) => setFilterMode(e.target.value as Route["filterMode"])}
              className="h-5 rounded border border-border bg-background px-1 text-[10px]"
            >
              <option value="and">all match (AND)</option>
              <option value="or">any matches (OR)</option>
            </select>
          )}
        </legend>
        {filters.map((filter, index) => (
          <FilterRowEditor
            key={index}
            filter={filter}
            suggestions={Object.keys(schemaProps)}
            onChange={(next) => setFilters((prev) => prev.map((f, i) => (i === index ? next : f)))}
            onRemove={() => setFilters((prev) => prev.filter((_, i) => i !== index))}
          />
        ))}
        <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={() => setFilters((prev) => [...prev, { field: "", op: "eq", value: "", caseSensitive: false }])}>
          <Plus className="h-3 w-3" /> Add filter
        </Button>
      </fieldset>

      {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

function groupByService(defs: ServiceTriggerDef[]): Record<string, ServiceTriggerDef[]> {
  const groups: Record<string, ServiceTriggerDef[]> = {};
  for (const triggerDef of defs) {
    const service = triggerDef.type.includes(":") ? triggerDef.type.split(":")[0] : "other";
    (groups[service] ??= []).push(triggerDef);
  }
  return groups;
}

function ParamField({
  param,
  value,
  onChange,
}: {
  param: ServiceTriggerParamDef;
  value: string | string[] | undefined;
  onChange: (next: string | string[]) => void;
}) {
  const id = React.useId();
  const selected = Array.isArray(value) ? value : [];
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]" title={param.description ?? param.name}>
        {param.label}
        {param.required && <span className="ml-0.5 text-destructive">*</span>}
        <span className="ml-1 text-muted-foreground/60">{param.name}</span>
      </Label>

      {param.multiselect && param.enum ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1" role="group" aria-label={param.label}>
          {param.enum.map((option) => {
            const optionStr = String(option);
            return (
              <label key={optionStr} className="flex items-center gap-1 text-[11px]">
                <input
                  type="checkbox"
                  checked={selected.includes(optionStr)}
                  onChange={() =>
                    onChange(selected.includes(optionStr)
                      ? selected.filter((v) => v !== optionStr)
                      : [...selected, optionStr])
                  }
                  className="size-3 accent-primary"
                />
                {optionStr}
              </label>
            );
          })}
        </div>
      ) : param.enum ? (
        <select
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">—</option>
          {param.enum.map((option) => (
            <option key={String(option)} value={String(option)}>{String(option)}</option>
          ))}
        </select>
      ) : param.type === "boolean" ? (
        <select
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : param.type === "json" ? (
        <textarea
          id={id}
          rows={3}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={param.default !== undefined ? formatParamValue(param.default) : "{}"}
          className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
      ) : (
        <Input
          id={id}
          type={param.type === "number" ? "number" : "text"}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={param.default !== undefined ? formatParamValue(param.default) : undefined}
          className="h-7 text-xs"
        />
      )}
      {param.description && <p className="text-[10px] text-muted-foreground/70">{param.description}</p>}
    </div>
  );
}

function FilterRowEditor({
  filter,
  suggestions,
  onChange,
  onRemove,
}: {
  filter: FilterRow;
  suggestions: string[];
  onChange: (next: FilterRow) => void;
  onRemove: () => void;
}) {
  const fieldId = React.useId();
  const opId = React.useId();
  const valueId = React.useId();
  return (
    <div className="flex items-end gap-1.5">
      <div className="min-w-24 flex-1">
        <Label htmlFor={fieldId} className="text-[10px] text-muted-foreground">Field</Label>
        <Input
          id={fieldId}
          list={suggestions.length > 0 ? `${fieldId}-list` : undefined}
          value={filter.field}
          onChange={(e) => onChange({ ...filter, field: e.target.value })}
          placeholder="payload field"
          className="h-7 font-mono text-[11px]"
        />
        {suggestions.length > 0 && (
          <datalist id={`${fieldId}-list`}>
            {suggestions.map((s) => <option key={s} value={s} />)}
          </datalist>
        )}
      </div>
      <div>
        <Label htmlFor={opId} className="text-[10px] text-muted-foreground">Op</Label>
        <select
          id={opId}
          value={filter.op}
          onChange={(e) => onChange({ ...filter, op: e.target.value as FilterRow["op"] })}
          className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="eq">eq</option>
          <option value="contains">contains</option>
        </select>
      </div>
      <div className="min-w-24 flex-1">
        <Label htmlFor={valueId} className="text-[10px] text-muted-foreground">Value</Label>
        <Input
          id={valueId}
          value={filter.value}
          onChange={(e) => onChange({ ...filter, value: e.target.value })}
          placeholder="expected value"
          className="h-7 text-[11px]"
        />
      </div>
      <label className="flex items-center gap-1 self-end pb-1.5 text-[10px] text-muted-foreground" title="Match string case exactly (default: case-insensitive)">
        <input
          type="checkbox"
          checked={filter.caseSensitive}
          onChange={(e) => onChange({ ...filter, caseSensitive: e.target.checked })}
          className="h-3 w-3"
        />
        Aa
      </label>
      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={onRemove} title="Remove filter" aria-label="Remove filter">
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

export default RouteForm;