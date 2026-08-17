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
  RotateCcw,
  Sparkles,
  Bot,
  Layers,
  Clock,
  Globe,
  GitPullRequest,
  Check,
  Cpu,
  Sliders,
  Filter,
} from "lucide-react";
import { useRunnerModels, type RunnerModel } from "@/hooks/useRunnerModels";
import { formatPathTail } from "@/lib/path";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { JsonValue, ServiceTriggerDef, ServiceTriggerParamDef } from "@pizzapi/protocol";

// ── Helpers ────────────────────────────────────────────────────────────────

function servicePrefix(type: string): string {
  const idx = type.indexOf(":");
  return idx > 0 ? type.slice(0, idx) : type;
}

function truncateCompactId(id?: string, fallback?: string, maxLen = 18): string {
  if (!id) return fallback ?? "listener";
  if (id.length <= maxLen) return id;
  return id.slice(0, maxLen) + "…";
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

function SourceIcon({ source, className }: { source: string; className?: string }) {
  const src = source.toLowerCase();
  if (src.includes("github") || src.includes("pr") || src.includes("issue")) {
    return <GitPullRequest className={cn("size-3.5 text-purple-400", className)} />;
  }
  if (src.includes("webhook") || src.includes("http")) {
    return <Globe className={cn("size-3.5 text-sky-400", className)} />;
  }
  if (src.includes("cron") || src.includes("schedule") || src.includes("time")) {
    return <Clock className={cn("size-3.5 text-emerald-400", className)} />;
  }
  if (src.includes("service")) {
    return <Settings className={cn("size-3.5 text-zinc-400", className)} />;
  }
  return <Layers className={cn("size-3.5 text-blue-400", className)} />;
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
  const updateConfig = (field: keyof SessionConfig, value: string | boolean) => {
    onSessionConfigChange({ ...sessionConfig, [field]: value });
  };

  return (
    <div className="mt-3 rounded-xl border border-violet-500/30 bg-violet-950/20 p-4 space-y-3.5 shadow-inner">
      <div className="flex items-center justify-between pb-2 border-b border-violet-500/20">
        <span className="text-xs font-semibold text-violet-300 flex items-center gap-1.5">
          <Sliders className="size-3.5" />
          Configure auto-spawn listener
        </span>
      </div>

      {/* Session config: cwd, prompt, model */}
      <div className="space-y-3 pb-3 border-b border-violet-500/20">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground/80 flex items-center justify-between">
            <span>Working Dir</span>
            <span className="text-[10px] text-muted-foreground/60 font-normal">execution folder</span>
          </label>
          <div className="space-y-1.5">
            <input
              type="text"
              placeholder="/path/to/project"
              value={sessionConfig.cwd}
              onChange={(e) => updateConfig("cwd", e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
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
                        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono border transition-all",
                        isSelected
                          ? "border-primary/50 bg-primary/20 text-primary-foreground font-semibold"
                          : "border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                      )}
                    >
                      <FolderOpen className="size-3 shrink-0 text-muted-foreground" />
                      {tail}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground/80">
            Prompt
          </label>
          <textarea
            rows={2}
            placeholder="Instructions for the spawned session"
            value={sessionConfig.prompt}
            onChange={(e) => updateConfig("prompt", e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-y leading-relaxed"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-foreground/80">
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
              className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Runner default</option>
              {models.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.name ?? m.id} ({m.provider})
                </option>
              ))}
            </select>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                placeholder="provider"
                value={sessionConfig.modelProvider}
                onChange={(e) => updateConfig("modelProvider", e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <input
                type="text"
                placeholder="model-id"
                value={sessionConfig.modelId}
                onChange={(e) => updateConfig("modelId", e.target.value)}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-0.5">
          <label className="text-xs font-medium text-foreground/80 w-24 shrink-0">
            Auto-close
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-xs text-foreground/90">
            <input
              type="checkbox"
              checked={sessionConfig.autoClose}
              onChange={(e) => onSessionConfigChange({ ...sessionConfig, autoClose: e.target.checked })}
              className="accent-primary size-3.5 rounded"
            />
            Shut down session on successful completion
          </label>
        </div>
      </div>

      {/* Trigger params */}
      {params.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="text-xs font-semibold text-violet-300 uppercase tracking-wider flex items-center gap-1.5">
            <Filter className="size-3" /> Filter params
          </div>

          <div className="space-y-2">
            {params.map((p) => {
              const currentVal = values[p.name];
              const selectedArr = Array.isArray(currentVal) ? currentVal : [];

              return (
                <div key={p.name} className="space-y-1">
                  <label
                    className="text-xs font-medium text-foreground/80 flex items-center justify-between"
                    title={p.description ?? p.name}
                  >
                    <span>{p.label}{p.required ? <span className="text-destructive ml-0.5">*</span> : ""}</span>
                    {p.description && <span className="text-[10px] text-muted-foreground/60 font-normal">{p.description}</span>}
                  </label>

                  {/* Multiselect: checkboxes */}
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
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {p.enum.map((opt) => {
                          const optStr = String(opt);
                          const checked = selectedArr.includes(optStr);
                          return (
                            <label key={optStr} className="flex items-center gap-1.5 cursor-pointer text-xs text-foreground/80">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  const next = checked
                                    ? selectedArr.filter(v => v !== optStr)
                                    : [...selectedArr, optStr];
                                  updateValue(p.name, next);
                                }}
                                className="accent-primary size-3 rounded"
                              />
                              {optStr}
                            </label>
                          );
                        })}
                      </div>
                    </div>

                  /* Enum single select: dropdown */
                  ) : p.enum ? (
                    <select
                      value={typeof currentVal === "string" ? currentVal : ""}
                      onChange={(e) => updateValue(p.name, e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="">—</option>
                      {p.enum.map((opt) => (
                        <option key={String(opt)} value={String(opt)}>{String(opt)}</option>
                      ))}
                    </select>

                  /* JSON */
                  ) : p.type === "json" ? (
                    <textarea
                      rows={3}
                      placeholder={p.default !== undefined ? formatParamValue(p.default) : "{}"}
                      value={typeof currentVal === "string" ? currentVal : ""}
                      onChange={(e) => updateValue(p.name, e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                    />

                  /* Boolean */
                  ) : p.type === "boolean" ? (
                    <select
                      value={typeof currentVal === "string" ? currentVal : ""}
                      onChange={(e) => updateValue(p.name, e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="">—</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>

                  /* Default: text/number input */
                  ) : (
                    <input
                      type={p.type === "number" ? "number" : "text"}
                      placeholder={p.default !== undefined ? formatParamValue(p.default) : undefined}
                      value={typeof currentVal === "string" ? currentVal : ""}
                      onChange={(e) => updateValue(p.name, e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-destructive bg-destructive/10 border border-destructive/30 px-3 py-2 rounded-md">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-violet-500/20">
        <Button size="sm" variant="outline" className="h-7 text-xs px-2.5" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" className="h-7 text-xs px-3.5 font-semibold bg-primary hover:bg-primary/90 text-primary-foreground" disabled={isPending} onClick={onSubmit}>
          {isPending ? <Loader2 className="size-3 animate-spin mr-1.5" /> : null}
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
    <div className="p-3 space-y-2 hover:bg-white/[0.01] transition-colors">
      {/* Header: label as primary, type as secondary */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-foreground">
              {def.label}
            </span>
            {isListening && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-emerald-500/40 text-emerald-400 bg-emerald-500/5 shrink-0 font-medium">
                {listeners.length} active
              </Badge>
            )}
            {hasParams && !isListening && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] h-4 border-violet-500/30 text-violet-400/80 bg-violet-500/5 shrink-0">
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

        {/* Add button */}
        <button
          type="button"
          onClick={() => onToggle(def, false)}
          disabled={isPending}
          className={cn(
            "inline-flex items-center gap-1 shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-all",
            isListening
              ? "text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/10 border border-transparent hover:border-emerald-500/20"
              : "bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm",
            isPending && "opacity-50 cursor-not-allowed",
          )}
          title={isListening ? "Add another auto-spawn listener" : "Add auto-spawn listener — spawns a new session when this trigger fires"}
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
        <div className="mt-2 space-y-2">
          {listeners.map((listener, index) => {
            const listenerKey = listener.listenerId ?? `${def.type}-${index}`;
            const isPendingListener = pendingTypes.has(listener.listenerId ?? "") || isPending;
            const details: string[] = [];
            if (listener.cwd) details.push(listener.cwd);
            if (listener.model) details.push(`${listener.model.provider}/${listener.model.id}`);
            if (listener.autoClose) details.push("auto-close");
            const paramBadges = listener.params
              ? Object.entries(listener.params).flatMap(([k, v]) => {
                  const badges = renderParamValueBadges(k, v, "px-1.5 py-0 text-[10px] h-4 border-emerald-500/30 text-emerald-400/90 bg-emerald-500/5 font-mono");
                  return Array.isArray(badges) ? badges : [badges];
                })
              : [];
            if (listener.params) {
              for (const [k, v] of Object.entries(listener.params)) {
                details.push(`${k}=${formatParamValue(v)}`);
              }
            }

            return (
              <div key={listenerKey} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 hover:border-zinc-700 transition-all space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0 space-y-1">
                    {listener.prompt ? (
                      <p className="text-xs font-medium text-foreground leading-snug" title={listener.prompt}>
                        "{listener.prompt.length > 80 ? listener.prompt.slice(0, 80) + "…" : listener.prompt}"
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground/60 italic">No custom prompt</p>
                    )}

                    {/* Metadata Pills */}
                    <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                      {listener.cwd && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-800/80 text-zinc-300 border border-zinc-700 font-mono text-[10px]">
                          <FolderOpen className="size-3 text-muted-foreground" />
                          {formatPathTail(listener.cwd, 1)}
                        </span>
                      )}
                      {listener.model && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-800/80 text-zinc-300 border border-zinc-700 font-mono text-[10px]">
                          <Bot className="size-3 text-muted-foreground" />
                          {listener.model.id}
                        </span>
                      )}
                      {listener.autoClose && (
                        <span className="px-1.5 py-0.5 rounded-md bg-zinc-800/50 text-zinc-400 text-[10px] border border-border/40">
                          auto-close
                        </span>
                      )}
                    </div>

                    {paramBadges.length > 0 && (
                      <div className="flex items-center gap-1 flex-wrap pt-1">
                        {paramBadges}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => onEdit(def, listener)}
                      disabled={isPendingListener}
                      className={cn(
                        "p-1.5 rounded-lg border border-border/40 bg-zinc-900 text-muted-foreground hover:text-blue-400 hover:bg-blue-500/10 transition-colors",
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
                        "p-1.5 rounded-lg border border-border/40 bg-zinc-900 text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 transition-colors",
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
      "rounded-xl border overflow-hidden shadow-sm transition-all",
      listenedCount > 0
        ? "border-emerald-500/30 bg-zinc-900/40"
        : "border-border/60 bg-zinc-900/30",
    )}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-white/[0.02] transition-colors"
      >
        <SourceIcon source={group.service} className="size-4 shrink-0" />
        <span className="text-xs font-semibold text-foreground/90 capitalize flex-1 text-left">
          {group.service}
        </span>
        <span className="text-[11px] text-muted-foreground/60">
          {group.defs.length} trigger{group.defs.length !== 1 ? "s" : ""}
        </span>
        {listenedCount > 0 && (
          <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-bold border border-emerald-500/30">
            {listenedCount}
          </span>
        )}
        <div className="shrink-0 text-muted-foreground/50 ml-1">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/40 divide-y divide-border/30 bg-zinc-950/20">
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
              sessionConfig={sessionConfigs[def.type] ?? { cwd: "", prompt: "", modelProvider: "", modelId: "", autoClose: false }}
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
  params?: Record<string, JsonValue>;
  autoClose?: boolean;
  createdAt: string;
}

interface SessionConfig {
  cwd: string;
  prompt: string;
  modelProvider: string;
  modelId: string;
  autoClose: boolean;
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
    const paramDefsByName = new Map((def.params ?? []).map((param) => [param.name, param]));
    if (listener?.params) {
      for (const [k, v] of Object.entries(listener.params)) {
        const paramDef = paramDefsByName.get(k);
        if (paramDef?.multiselect && Array.isArray(v)) vals[k] = v.map(String);
        else vals[k] = formatParamValue(v);
      }
    }
    if (def.params) {
      for (const p of def.params) {
        if (vals[p.name] !== undefined) continue;
        if (p.multiselect) vals[p.name] = [];
        else if (p.default !== undefined) vals[p.name] = formatParamValue(p.default);
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
        autoClose: listener?.autoClose ?? false,
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
          else if (p.default !== undefined) defaults[p.name] = formatParamValue(p.default);
        }
      }
      setParamValues((prev) => ({ ...prev, [def.type]: { ...defaults, ...prev[def.type] } }));
      setSessionConfigs((prev) => ({
        ...prev,
        [def.type]: prev[def.type] ?? { cwd: "", prompt: "", modelProvider: "", modelId: "", autoClose: false },
      }));
    }
  }, [runnerId]);

  const handleParamSubmit = React.useCallback((def: ServiceTriggerDef) => {
    const vals = paramValues[def.type] ?? {};
    const params: Record<string, JsonValue> = {};
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

    const cfg = sessionConfigs[def.type];
    const sessionConfig = cfg ? {
      cwd: cfg.cwd.trim() || undefined,
      prompt: cfg.prompt.trim() || undefined,
      model: (cfg.modelProvider.trim() && cfg.modelId.trim())
        ? { provider: cfg.modelProvider.trim(), id: cfg.modelId.trim() }
        : undefined,
      autoClose: cfg.autoClose || undefined,
    } : undefined;

    setPendingTypes((prev) => new Set([...prev, editingListenerId ?? def.type]));
    setParamError(null);

    void (async () => {
      try {
        if (editMode) {
          const res = await fetch(
            `/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners/${encodeURIComponent(def.type)}`,
            {
              method: "PUT",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                listenerId: editingListenerId ?? undefined,
                params: Object.keys(params).length > 0 ? params : undefined,
                ...sessionConfig,
              }),
            },
          );
          if (res.ok) {
            const data = await res.json() as { listener?: ListenerInfo };
            if (data.listener) {
              setListeners((prev) => prev.map((l) => (
                (editingListenerId && l.listenerId === editingListenerId)
                || (!editingListenerId && l.triggerType === def.type)
                  ? data.listener!
                  : l
              )));
            }
            setParamFormOpen(null);
            setEditingListenerId(null);
            setEditMode(false);
          } else {
            const data = await res.json().catch(() => ({})) as { error?: string };
            setParamError(data.error ?? `HTTP ${res.status}`);
          }
        } else {
          const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/trigger-listeners`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              triggerType: def.type,
              params: Object.keys(params).length > 0 ? params : undefined,
              ...sessionConfig,
            }),
          });
          if (res.ok) {
            const data = await res.json() as { listener?: ListenerInfo };
            if (data.listener) {
              setListeners((prev) => [...prev, data.listener!]);
            }
            setParamFormOpen(null);
            setEditingListenerId(null);
            setEditMode(false);
          } else {
            const data = await res.json().catch(() => ({})) as { error?: string };
            setParamError(data.error ?? `HTTP ${res.status}`);
          }
        }
      } catch (err) {
        setParamError(err instanceof Error ? err.message : "Failed to save listener");
      } finally {
        setPendingTypes((prev) => {
          const next = new Set(prev);
          next.delete(editingListenerId ?? def.type);
          return next;
        });
      }
    })();
  }, [paramValues, sessionConfigs, runnerId, editMode, editingListenerId]);

  return (
    <div className="space-y-4">
      {/* Header Info */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="size-6 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
            <Zap className="size-3.5" />
          </span>
          <div>
            <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider">
              Service Trigger Catalog
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Auto-spawn sessions when runner service events occur.
            </p>
          </div>
        </div>

        {listeners.length > 0 && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-semibold">
            <span className="size-1.5 rounded-full bg-emerald-400"></span>
            {listeners.length} listener{listeners.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center h-36 gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin text-primary" />
          <span className="text-xs font-medium">Loading triggers…</span>
        </div>
      ) : error ? (
        <p className="text-xs text-destructive text-center bg-destructive/10 border border-destructive/20 p-3 rounded-lg">{error}</p>
      ) : triggerDefs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 p-6 text-center rounded-xl border border-dashed border-border/60">
          <BookOpen className="size-8 text-muted-foreground/30" />
          <p className="text-xs text-muted-foreground">
            No trigger types available. Services declare triggers via manifests.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
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
              onParamCancel={() => {
                setParamFormOpen(null);
                setEditingListenerId(null);
                setEditMode(false);
                setParamError(null);
              }}
              models={models}
              recentFolders={recentFolders}
            />
          ))}
        </div>
      )}
    </div>
  );
}
