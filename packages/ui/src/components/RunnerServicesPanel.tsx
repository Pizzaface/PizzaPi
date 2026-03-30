/**
 * RunnerServicesPanel — runner-level services overview.
 *
 * Shows user-installed runner services as cards with their icon, label,
 * and counts of triggers and sigils they provide. Built-in system services
 * (terminal, file-explorer, git, tunnel) are hidden. Users can toggle
 * visibility of service panel buttons in the session header.
 */
import * as React from "react";
import { Loader2, Server, ExternalLink, Eye, EyeOff, Zap, Hash } from "lucide-react";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

/** Built-in system service IDs — hidden from the user-facing panel. */
const BUILTIN_SERVICE_IDS = new Set(["terminal", "file-explorer", "git", "tunnel"]);

const HIDDEN_PANELS_KEY = "pp-hidden-service-panels";

function loadHiddenPanels(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_PANELS_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveHiddenPanels(hidden: Set<string>) {
  try {
    localStorage.setItem(HIDDEN_PANELS_KEY, JSON.stringify([...hidden]));
  } catch { /* ignore */ }
}

/** Export for use by ServicePanelButtons to filter visible panels. */
export function getHiddenServicePanels(): Set<string> {
  return loadHiddenPanels();
}

interface ServicePanel {
  serviceId: string;
  port: number;
  label: string;
  icon: string;
}

interface TriggerDef {
  type: string;
  label: string;
  description?: string;
}

interface SigilDef {
  type: string;
  label: string;
  serviceId?: string;
}

export interface RunnerServicesPanelProps {
  runnerId: string;
}

/** Extract service namespace from a namespaced type like "godmother:idea_moved" → "godmother" */
function serviceNamespace(type: string): string {
  const i = type.indexOf(":");
  return i >= 0 ? type.slice(0, i) : type;
}

interface ServiceInfo {
  id: string;
  panel?: ServicePanel;
  triggerCount: number;
  sigilCount: number;
}

export function RunnerServicesPanel({ runnerId }: RunnerServicesPanelProps) {
  const [services, setServices] = React.useState<ServiceInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [hiddenPanels, setHiddenPanels] = React.useState<Set<string>>(loadHiddenPanels);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/services`, {
          credentials: "include",
        });
        if (cancelled) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as {
          serviceIds?: string[];
          panels?: ServicePanel[];
          triggerDefs?: TriggerDef[];
          sigilDefs?: SigilDef[];
        };
        if (cancelled) return;

        const serviceIds = (data.serviceIds ?? []).filter(id => !BUILTIN_SERVICE_IDS.has(id));
        const panelMap = new Map((data.panels ?? []).map(p => [p.serviceId, p]));
        const triggerDefs = data.triggerDefs ?? [];
        const sigilDefs = data.sigilDefs ?? [];

        // Count triggers per service namespace
        const triggerCounts = new Map<string, number>();
        for (const t of triggerDefs) {
          const ns = serviceNamespace(t.type);
          triggerCounts.set(ns, (triggerCounts.get(ns) || 0) + 1);
        }

        // Count sigils per service (use serviceId field, fall back to type namespace)
        const sigilCounts = new Map<string, number>();
        for (const s of sigilDefs) {
          const ns = s.serviceId || serviceNamespace(s.type);
          sigilCounts.set(ns, (sigilCounts.get(ns) || 0) + 1);
        }

        const result: ServiceInfo[] = serviceIds.map(id => ({
          id,
          panel: panelMap.get(id),
          triggerCount: triggerCounts.get(id) || 0,
          sigilCount: sigilCounts.get(id) || 0,
        }));

        setServices(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load services");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [runnerId]);

  const toggleHidden = React.useCallback((serviceId: string) => {
    setHiddenPanels(prev => {
      const next = new Set(prev);
      if (next.has(serviceId)) {
        next.delete(serviceId);
      } else {
        next.add(serviceId);
      }
      saveHiddenPanels(next);
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span className="text-sm">Loading services…</span>
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

  if (services.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <Server className="size-10 text-muted-foreground/30" />
        <div>
          <p className="text-sm text-muted-foreground">No services installed</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Drop service plugins into ~/.pizzapi/services/ to add them.
          </p>
        </div>
      </div>
    );
  }

  const handleOpen = (panel: ServicePanel) => {
    const url = `/api/tunnel/runner/${encodeURIComponent(runnerId)}/${panel.port}/`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {services.map((svc) => {
        const isHidden = hiddenPanels.has(svc.id);
        const hasPanel = !!svc.panel;

        return (
          <div
            key={svc.id}
            className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
              isHidden
                ? "opacity-50 border-border/30 bg-muted/5"
                : "border-border/50 bg-muted/10 hover:bg-muted/20"
            }`}
          >
            {/* Icon */}
            <div className="flex items-center justify-center size-9 rounded-lg border bg-muted/30 border-border/30 flex-shrink-0">
              {svc.panel ? (
                <DynamicLucideIcon name={svc.panel.icon} className="size-4 text-foreground/70" />
              ) : (
                <Server className="size-4 text-foreground/40" />
              )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">
                  {svc.panel?.label || svc.id}
                </span>
                {hasPanel && (
                  <button
                    onClick={() => handleOpen(svc.panel!)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="Open in new tab"
                  >
                    <ExternalLink className="size-3" />
                  </button>
                )}
              </div>

              {/* Trigger + Sigil counts */}
              <div className="flex items-center gap-3 mt-1">
                {svc.triggerCount > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Zap className="size-3" />
                        {svc.triggerCount} trigger{svc.triggerCount !== 1 ? "s" : ""}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Subscribable trigger events</TooltipContent>
                  </Tooltip>
                )}
                {svc.sigilCount > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Hash className="size-3" />
                        {svc.sigilCount} sigil{svc.sigilCount !== 1 ? "s" : ""}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Inline reference types ([[type:id]])</TooltipContent>
                  </Tooltip>
                )}
                {svc.triggerCount === 0 && svc.sigilCount === 0 && !hasPanel && (
                  <span className="text-[10px] text-muted-foreground/50 italic">No public capabilities</span>
                )}
              </div>
            </div>

            {/* Hide/show toggle for panel visibility */}
            {hasPanel && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => toggleHidden(svc.id)}
                    className={`flex-shrink-0 p-1 rounded transition-colors ${
                      isHidden
                        ? "text-muted-foreground/50 hover:text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    aria-label={isHidden ? `Show ${svc.panel!.label} panel` : `Hide ${svc.panel!.label} panel`}
                  >
                    {isHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {isHidden ? "Show panel button in session header" : "Hide panel button from session header"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        );
      })}
    </div>
  );
}
