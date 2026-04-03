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
  Plus,
  Trash2,
  Zap,
  FolderOpen,
  Pencil,
} from "lucide-react";
import { useRunnerModels, type RunnerModel } from "@/hooks/useRunnerModels";
import { formatPathTail } from "@/lib/path";
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

function truncateCompactId(id?: string, fallback?: string, maxLen = 18): string {
  if (!id) return fallback ?? "listener";
  if (id.length <= maxLen) return id;
  return id.slice(0, maxLen) + "…";
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
  sessionConfig: SessionConfig;
  onSessionConfigChange: (config: SessionConfig) => void;
  error: string | null;
  onSubmit: () => void;
  onCancel: () => void;
  isPending: boolean;
  models: RunnerModel[];
  recentFolders: string[];
  submitLabel?: string;
}

function ParamForm({
  params, values, onChange, sessionConfig, onSessionConfigChange,
  error, onSubmit, onCancel, isPending, models, recentFolders, submitLabel = "Subscribe",
}: ParamFormProps) {
  const updateValue = (name: string, value: string | string[]) => {
    onChange({ ...values, [name]: value });
  };
  const updateConfig = (field: keyof SessionConfig, value: string) => {
    onSessionConfigChange({ ...sessionConfig, [field]: value });
  };

  return (
    <div className="mt-2 rounded border border-violet-500/20 bg-violet-950/10 p-2.5 space-y-2.5">
      <div className="text-[11px] font-medium text-violet-300/80">Configure auto-spawn listener</div>

      {/* Session config: cwd, prompt, model */}
      <div className="space-y-2 pb-2 border-b border-violet-500/10">
        <div className="flex items-start gap-2">
          <label className="text-[11px] text-muted-foreground/70 w-24 shrink-0 pt-0.5">
            Working Dir
          </label>
          <div className="flex-1 space-y-1">
            <input
              type="text"
              placeholder="/path/to/project"
              value={sessionConfig.cwd}
              onChange={(e) => updateConfig("cwd", e.target.value)}
              className="w-full rounded border border-border bg-background px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {recentFolders.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {recentFolders.slice(0, 6).map((folder) => {
                  const tail = formatPathTail(folder, 1);
                  const isSelected = sessionConfig.cwd === folder;
                  return (
                    <button
                      key={folder}
                      type="button"
                      title={folder}
                      onClick={() => updateConfig("cwd", folder)}
                      className={cn(
                        "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors",
                        isSelected
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border/50 bg-muted/30 text-muted-foreground hover:bg-muted/60",
                      )}
                    >
                      <FolderOpen className="size-2.5 shrink-0" />
                      {tail}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-start gap-2">
          <label className="text-[11px] text-muted-foreground/70 w-24 shrink-0 pt-0.5">
            Prompt
          </label>
          <textarea
            rows={2}
            placeholder="Instructions for the spawned session"
            value={sessionConfig.prompt}
            onChange={(e) => updateConfig("prompt", e.target.value)}
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring resize-y"
          />
        </div>
        <div className="flex items-start gap-2">
          <label className="text-[11px] text-muted-foreground/70 w-24 shrink-0 pt-0.5">
            Model
          </label>
          {models.length > 0 ? (
            <select
              value={sessionConfig.modelProvider && sessionConfig.modelId
                ? `${sessionConfig.modelProvider}/${sessionConfig.modelId}`
                : ""}
              onChange={(e) => {
                const val = e.target.value;
                if (!val) {
                  onSessionConfigChange({ ...sessionConfig, modelProvider: "", modelId: "" });
                } else {
                  const sep = val.indexOf("/");
                  onSessionConfigChange({
                    ...sessionConfig,
                    modelProvider: val.slice(0, sep),
                    modelId: val.slice(sep + 1),
                  });
                }
              }}
              className="flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">Runner default</option>
              {models.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.name ?? m.id} ({m.provider})
                </option>
              ))}
            </select>
          ) : (
            <div className="flex-1 grid grid-cols-2 gap-1.5">
              <input
                type="text"
                placeholder="provider"
                value={sessionConfig.modelProvider}
                onChange={(e) => updateConfig("modelProvider", e.target.value)}
                className="rounded border border-border bg-background px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <input
                type="text"
                placeholder="model-id"
                value={sessionConfig.modelId}
                onChange={(e) => updateConfig("modelId", e.target.value)}
                className="rounded border border-border bg-background px-2 py-1 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          )}
        </div>
      </div>

      {/* Trigger params */}
      {params.length > 0 && (
        <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wide">
          Filter params
        </div>
      )}
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
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

// ── Collapsible Param Definitions ──────────────────────────────────────────

function CollapsibleParams({ params }: { params: ServiceTriggerParamDef[] }) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground/80 transition-colors"
      >
        {expanded ? <ChevronDown className="size-2.5" /> : <ChevronRight className="size-2.5" />}
        <span>{params.length} param{params.length !== 1 ? "s" : ""}</span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5 pl-3.5">
          {params.map((p) => (
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
  );
}

// ── Trigger Item ───────────────────────────────────────────────────────────

interface TriggerItemProps {
  def: ServiceTriggerDef;
  listeners: ListenerInfo[];
  isPending: boolean;
  pendingTypes: Set<string>;
  paramFormOpen: boolean;
  editMode: boolean;
  paramValues: Record<string, string | string[]>;
  paramError: string | null;
  sessionConfig: SessionConfig;
  onToggle: (def: ServiceTriggerDef, isListening: boolean, listenerId?: string) => void;
  onEdit: (def: ServiceTriggerDef, listener?: ListenerInfo) => void;
  onParamValuesChange: (values: Record<string, string | string[]>) => void;
  onSessionConfigChange: (config: SessionConfig) => void;
  onParamSubmit: (def: ServiceTriggerDef) => void;
  onParamCancel: () => void;
  models: RunnerModel[];
  recentFolders: string[];
}

function TriggerItem({
  def, listeners, isPending, pendingTypes,
  paramFormOpen, editMode, paramValues, paramError, sessionConfig,
  onToggle, onEdit, onParamValuesChange, onSessionConfigChange, onParamSubmit, onParamCancel,
  models, recentFolders,
}: TriggerItemProps) {
  const hasParams = def.params && def.params.length > 0;
  const isListening = listeners.length > 0;

  return (
    <div className="px-3 py-2.5">
      {/* Header: label as primary, type as secondary */}
      <div className="flex items-start gap-2">
        <Zap className={cn("size-3.5 mt-0.5 shrink-0", isListening ? "text-emerald-400" : "text-muted-foreground/40")} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs font-medium text-foreground">
              {def.label}
            </span>
            {isListening && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-emerald-500/40 text-emerald-400 shrink-0">
                {listeners.length} active
              </Badge>
            )}
            {hasParams && !isListening && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-violet-500/30 text-violet-400/70 shrink-0">
                configurable
              </Badge>
            )}
          </div>
          <span className="text-[10px] font-mono text-muted-foreground/50 block">
            {def.type}
          </span>
          {def.description && (
            <p className="text-[11px] text-muted-foreground/70 mt-0.5 leading-snug">
              {def.description}
            </p>
          )}
        </div>

        {/* Add button */}
        <button
          type="button"
          onClick={() => onToggle(def, false)}
          disabled={isPending}
          className={cn(
            "inline-flex items-center gap-1 shrink-0 px-2 py-1 rounded text-[11px] font-medium transition-colors",
            "text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/10 border border-transparent hover:border-emerald-500/20",
            isPending && "opacity-50 cursor-not-allowed",
          )}
          title={isListening ? "Add another auto-spawn listener" : "Add auto-spawn listener \u2014 spawns a new session when this trigger fires"}
          aria-label={isListening ? `Add another listener for ${def.type}` : `Add listener for ${def.type}`}
        >
          {isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
          Add
        </button>
      </div>

      {/* Existing listeners */}
      {isListening && (
        <div className="mt-2 ml-[22px] space-y-1.5">
          {listeners.map((listener, index) => {
            const listenerKey = listener.listenerId ?? `${def.type}-${index}`;
            const isPendingListener = pendingTypes.has(listener.listenerId ?? "") || isPending;
            const details: string[] = [];
            if (listener.cwd) details.push(listener.cwd);
            if (listener.model) details.push(`${listener.model.provider}/${listener.model.id}`);
            if (listener.params) {
              for (const [k, v] of Object.entries(listener.params)) {
                details.push(`${k}=${Array.isArray(v) ? v.map(String).join(", ") : String(v)}`);
              }
            }
            return (
              <div key={listenerKey} className="rounded-md border border-border/40 bg-muted/20 px-2.5 py-1.5">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    {listener.prompt && (
                      <p className="text-[11px] text-foreground/80 truncate" title={listener.prompt}>
                        {listener.prompt.length > 60 ? listener.prompt.slice(0, 60) + "\u2026" : listener.prompt}
                      </p>
                    )}
                    {details.length > 0 && (
                      <p className="text-[10px] font-mono text-muted-foreground/50 truncate">
                        {details.join(" \u00B7 ")}
                      </p>
                    )}
                    {!listener.prompt && details.length === 0 && (
                      <p className="text-[10px] text-muted-foreground/40 italic">No config</p>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => onEdit(def, listener)}
                      disabled={isPendingListener}
                      className={cn(
                        "p-1 rounded transition-colors text-muted-foreground/40 hover:text-blue-400 hover:bg-blue-500/10",
                        isPendingListener && "opacity-50 cursor-not-allowed",
                      )}
                      title="Edit listener"
                      aria-label={`Edit listener ${listener.listenerId ?? index + 1} for ${def.type}`}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggle(def, true, listener.listenerId)}
                      disabled={isPendingListener}
                      className={cn(
                        "p-1 rounded transition-colors text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10",
                        isPendingListener && "opacity-50 cursor-not-allowed",
                      )}
                      title="Remove listener"
                      aria-label={`Delete listener ${listener.listenerId ?? index + 1} for ${def.type}`}
                    >
                      {isPendingListener ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Collapsible param definitions (when not subscribed and form not open) */}
      {hasParams && !isListening && !paramFormOpen && (
        <CollapsibleParams params={def.params!} />
      )}

      {/* Inline config form */}
      {paramFormOpen && (
        <ParamForm
          params={def.params ?? []}
          values={paramValues}
          onChange={onParamValuesChange}
          sessionConfig={sessionConfig}
          onSessionConfigChange={onSessionConfigChange}
          error={paramError}
          onSubmit={() => onParamSubmit(def)}
          onCancel={onParamCancel}
          isPending={isPending}
          models={models}
          recentFolders={recentFolders}
          submitLabel={editMode ? "Update" : "Subscribe"}
        />
      )}
    </div>
  );
}

// ── Service Accordion ──────────────────────────────────────────────────────

interface ServiceAccordionProps {
  group: ServiceGroup;
  listenedTypes: Set<string>;
  listenersByType: Map<string, ListenerInfo[]>;
  pendingTypes: Set<string>;
  paramFormOpen: string | null;
  editMode: boolean;
  paramValues: Record<string, Record<string, string | string[]>>;
  paramError: string | null;
  sessionConfigs: Record<string, SessionConfig>;
  onToggle: (def: ServiceTriggerDef, isListening: boolean, listenerId?: string) => void;
  onEdit: (def: ServiceTriggerDef, listener?: ListenerInfo) => void;
  onParamValuesChange: (triggerType: string, values: Record<string, string | string[]>) => void;
  onSessionConfigChange: (triggerType: string, config: SessionConfig) => void;
  onParamSubmit: (def: ServiceTriggerDef) => void;
  onParamCancel: () => void;
  models: RunnerModel[];
  recentFolders: string[];
}

function ServiceAccordion({
  group, listenedTypes, listenersByType, pendingTypes,
  paramFormOpen, editMode, paramValues, paramError, sessionConfigs,
  onToggle, onEdit, onParamValuesChange, onSessionConfigChange, onParamSubmit, onParamCancel,
  models, recentFolders,
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
              listeners={listenersByType.get(def.type) ?? []}
              isPending={pendingTypes.has(def.type)}
              pendingTypes={pendingTypes}
              paramFormOpen={paramFormOpen === def.type}
              editMode={editMode && paramFormOpen === def.type}
              paramValues={paramValues[def.type] ?? {}}
              paramError={paramFormOpen === def.type ? paramError : null}
              sessionConfig={sessionConfigs[def.type] ?? { cwd: "", prompt: "", modelProvider: "", modelId: "" }}
              onToggle={onToggle}
              onEdit={onEdit}
              onParamValuesChange={(vals) => onParamValuesChange(def.type, vals)}
              onSessionConfigChange={(config) => onSessionConfigChange(def.type, config)}
              onParamSubmit={onParamSubmit}
              onParamCancel={onParamCancel}
              models={models}
              recentFolders={recentFolders}
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
  listenerId?: string;
  triggerType: string;
  prompt?: string;
  cwd?: string;
  model?: { provider: string; id: string };
  params?: Record<string, unknown>;
  createdAt: string;
}

interface SessionConfig {
  cwd: string;
  prompt: string;
  modelProvider: string;
  modelId: string;
}

export function RunnerTriggersPanel({ runnerId, triggerDefs: propDefs }: RunnerTriggersPanelProps) {
  const [fetchedDefs, setFetchedDefs] = React.useState<ServiceTriggerDef[]>([]);
  const [listeners, setListeners] = React.useState<ListenerInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pendingTypes, setPendingTypes] = React.useState<Set<string>>(new Set());

  // Param form state
  const [paramFormOpen, setParamFormOpen] = React.useState<string | null>(null);
  const [editingListenerId, setEditingListenerId] = React.useState<string | null>(null);
  const [editMode, setEditMode] = React.useState(false);
  const [paramValues, setParamValues] = React.useState<Record<string, Record<string, string | string[]>>>({});
  const [paramError, setParamError] = React.useState<string | null>(null);
  const [sessionConfigs, setSessionConfigs] = React.useState<Record<string, SessionConfig>>({});

  // Runner-level data: models + recent folders
  const { models } = useRunnerModels(runnerId);
  const [recentFolders, setRecentFolders] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!runnerId) return;
    let cancelled = false;
    fetch(`/api/runners/${encodeURIComponent(runnerId)}/recent-folders`, {
      credentials: "include",
    })
      .then((res) => { if (!res.ok) throw new Error(); return res.json(); })
      .then((body: any) => { if (!cancelled) setRecentFolders(Array.isArray(body?.folders) ? body.folders : []); })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [runnerId]);

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
    let cancelled = false;
    setListeners([]); // Clear stale data from previous runner
    if (propDefs && propDefs.length > 0) {
      void (async () => {
        try {
          const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners`, {
            credentials: "include",
          });
          if (cancelled) return;
          if (res.ok) {
            const data = await res.json() as { listeners?: ListenerInfo[] };
            if (!cancelled) setListeners(data.listeners ?? []);
          }
        } catch { /* best-effort */ }
      })();
      return () => { cancelled = true; };
    }
    void fetchData();
    return () => { cancelled = true; };
  }, [runnerId, propDefs, fetchData]);

  const triggerDefs = (propDefs && propDefs.length > 0) ? propDefs : fetchedDefs;
  const serviceGroups = React.useMemo(() => groupByService(triggerDefs), [triggerDefs]);
  const listenedTypes = React.useMemo(() => new Set(listeners.map((l) => l.triggerType)), [listeners]);
  const listenersByType = React.useMemo(() => {
    const map = new Map<string, ListenerInfo[]>();
    for (const listener of listeners) {
      const existing = map.get(listener.triggerType);
      if (existing) existing.push(listener);
      else map.set(listener.triggerType, [listener]);
    }
    return map;
  }, [listeners]);

  // Find trigger def by type (for param validation)
  const defsByType = React.useMemo(() => {
    const map = new Map<string, ServiceTriggerDef>();
    for (const d of triggerDefs) map.set(d.type, d);
    return map;
  }, [triggerDefs]);

  /** Open the config form pre-populated with current listener config for editing. */
  const handleEdit = React.useCallback((def: ServiceTriggerDef, listener?: ListenerInfo) => {
    setParamFormOpen(def.type);
    setEditMode(true);
    setEditingListenerId(listener?.listenerId ?? null);
    setParamError(null);

    // Pre-populate param values from current listener
    const vals: Record<string, string | string[]> = {};
    if (listener?.params) {
      for (const [k, v] of Object.entries(listener.params)) {
        if (Array.isArray(v)) vals[k] = v.map(String);
        else vals[k] = String(v);
      }
    }
    if (def.params) {
      for (const p of def.params) {
        if (vals[p.name] !== undefined) continue;
        if (p.multiselect) vals[p.name] = [];
        else if (p.default !== undefined) vals[p.name] = String(p.default);
      }
    }
    setParamValues((prev) => ({ ...prev, [def.type]: vals }));

    // Pre-populate session config
    setSessionConfigs((prev) => ({
      ...prev,
      [def.type]: {
        cwd: listener?.cwd ?? "",
        prompt: listener?.prompt ?? "",
        modelProvider: listener?.model?.provider ?? "",
        modelId: listener?.model?.id ?? "",
      },
    }));
  }, []);

  const handleToggle = React.useCallback((def: ServiceTriggerDef, isListening: boolean, listenerId?: string) => {
    if (isListening) {
      // Unsubscribe directly
      setPendingTypes((prev) => new Set([...prev, listenerId ?? def.type]));
      void (async () => {
        try {
          const target = listenerId ?? def.type;
          const res = await fetch(
            `/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners/${encodeURIComponent(target)}`,
            { method: "DELETE", credentials: "include" },
          );
          if (res.ok) {
            setListeners((prev) => prev.filter((l) => (listenerId ? l.listenerId !== listenerId : l.triggerType !== def.type)));
          }
        } catch { /* best-effort */ } finally {
          setPendingTypes((prev) => { const n = new Set(prev); n.delete(listenerId ?? def.type); return n; });
        }
      })();
    } else {
      // Always open the config form so user can set cwd/prompt/model
      setParamFormOpen(def.type);
      setEditMode(false);
      setEditingListenerId(null);
      setParamError(null);
      const defaults: Record<string, string | string[]> = {};
      if (def.params) {
        for (const p of def.params) {
          if (p.multiselect) defaults[p.name] = [];
          else if (p.default !== undefined) defaults[p.name] = String(p.default);
        }
      }
      setParamValues((prev) => ({ ...prev, [def.type]: { ...defaults, ...prev[def.type] } }));
      setSessionConfigs((prev) => ({
        ...prev,
        [def.type]: prev[def.type] ?? { cwd: "", prompt: "", modelProvider: "", modelId: "" },
      }));
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

    const sc = sessionConfigs[def.type] ?? { cwd: "", prompt: "", modelProvider: "", modelId: "" };
    const cwd = sc.cwd.trim() || undefined;
    const prompt = sc.prompt.trim() || undefined;
    const model = sc.modelProvider.trim() && sc.modelId.trim()
      ? { provider: sc.modelProvider.trim(), id: sc.modelId.trim() }
      : undefined;

    const pendingKey = editingListenerId ?? def.type;
    setPendingTypes((prev) => new Set([...prev, pendingKey]));
    setParamError(null);
    void (async () => {
      try {
        // Use PUT when editing an existing listener, POST when creating new
        const url = editMode
          ? `/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners/${encodeURIComponent(editingListenerId ?? def.type)}`
          : `/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners`;
        const method = editMode ? "PUT" : "POST";
        const res = await fetch(url, {
            method,
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(editMode ? {} : { triggerType: def.type }),
              ...(Object.keys(params).length > 0 ? { params } : {}),
              ...(cwd ? { cwd } : {}),
              ...(prompt ? { prompt } : {}),
              ...(model ? { model } : {}),
            }),
          },
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          setParamError(data.error ?? `HTTP ${res.status}`);
          return;
        }
        const data = await res.json().catch(() => ({})) as { listenerId?: string };
        setParamFormOpen(null);
        setEditMode(false);
        setEditingListenerId(null);
            setListeners((prev) => {
          const existing = editingListenerId
            ? prev.find((listener) => listener.listenerId === editingListenerId)
            : undefined;
          const nextListener: ListenerInfo = {
            listenerId: data.listenerId ?? editingListenerId ?? undefined,
            triggerType: def.type,
            params: Object.keys(params).length > 0 ? params : undefined,
            cwd,
            prompt,
            model,
            createdAt: existing?.createdAt ?? new Date().toISOString(),
          };
          if (editingListenerId) {
            return prev.map((listener) => listener.listenerId === editingListenerId ? nextListener : listener);
          }
          return [...prev, nextListener];
        });
      } catch { /* best-effort */ } finally {
        setPendingTypes((prev) => { const n = new Set(prev); n.delete(pendingKey); return n; });
      }
    })();
  }, [runnerId, paramValues, sessionConfigs, editMode, editingListenerId]);

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

  if (triggerDefs.length === 0 && listeners.length === 0) {
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
          listenersByType={listenersByType}
          pendingTypes={pendingTypes}
          paramFormOpen={paramFormOpen}
          editMode={editMode}
          paramValues={paramValues}
          paramError={paramError}
          sessionConfigs={sessionConfigs}
          onToggle={handleToggle}
          onEdit={handleEdit}
          onParamValuesChange={(type, vals) => setParamValues((prev) => ({ ...prev, [type]: vals }))}
          onSessionConfigChange={(type, config) => setSessionConfigs((prev) => ({ ...prev, [type]: config }))}
          onParamSubmit={handleParamSubmit}
          onParamCancel={() => { setParamFormOpen(null); setEditMode(false); setEditingListenerId(null); setParamError(null); }}
          models={models}
          recentFolders={recentFolders}
        />
      ))}
    </div>
  );
}
