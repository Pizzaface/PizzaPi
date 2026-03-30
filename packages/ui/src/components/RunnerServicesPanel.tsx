/**
 * RunnerServicesPanel — runner-level services overview.
 *
 * Shows user-installed runner services as square cards with their icon and label.
 * Hides built-in system services (terminal, file-explorer, git, tunnel).
 * Clicking a card opens the service panel in a new browser tab via the runner tunnel.
 * Fetches from GET /api/runners/:id/services.
 */
import * as React from "react";
import { Loader2, Server, ExternalLink } from "lucide-react";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";

/** Built-in system service IDs — hidden from the user-facing panel. */
const BUILTIN_SERVICE_IDS = new Set(["terminal", "file-explorer", "git", "tunnel"]);

interface ServicePanel {
  serviceId: string;
  port: number;
  label: string;
  icon: string;
}

export interface RunnerServicesPanelProps {
  runnerId: string;
}

export function RunnerServicesPanel({ runnerId }: RunnerServicesPanelProps) {
  const [panels, setPanels] = React.useState<ServicePanel[]>([]);
  const [serviceIds, setServiceIds] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

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
        const data = await res.json() as { serviceIds?: string[]; panels?: ServicePanel[] };
        if (cancelled) return;
        setServiceIds(data.serviceIds ?? []);
        setPanels(data.panels ?? []);
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

  // Filter out built-in system services
  const userServiceIds = serviceIds.filter((id) => !BUILTIN_SERVICE_IDS.has(id));

  if (userServiceIds.length === 0) {
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

  // Only show services that have a panel — services that only provide sigils,
  // triggers, or other non-UI capabilities have no panel and should not appear.
  const panelMap = new Map(panels.map((p) => [p.serviceId, p]));
  const userPanels = userServiceIds
    .map((id) => panelMap.get(id))
    .filter((p): p is ServicePanel => p !== undefined);

  if (userPanels.length === 0) {
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
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
      {userPanels.map((panel) => (
        <button
          key={panel.serviceId}
          type="button"
          onClick={() => handleOpen(panel)}
          className="flex flex-col items-center justify-center gap-2 p-4 rounded-lg border relative group bg-muted/10 border-border/50 hover:bg-muted/30 hover:border-border cursor-pointer transition-colors"
        >
          <ExternalLink className="absolute top-2 right-2 size-3 text-muted-foreground/0 group-hover:text-muted-foreground/50 transition-colors" />
          <div className="flex items-center justify-center size-10 rounded-lg border bg-muted/30 border-border/30">
            <DynamicLucideIcon name={panel.icon} className="size-5 text-foreground/70" />
          </div>
          <span className="text-xs font-medium text-foreground/80 text-center truncate w-full">
            {panel.label}
          </span>
        </button>
      ))}
    </div>
  );
}
