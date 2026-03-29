/**
 * RunnerServicesPanel — runner-level services overview.
 *
 * Shows runner services as square cards with their icon and label.
 * Fetches from GET /api/runners/:id/services.
 */
import * as React from "react";
import { Loader2, Server } from "lucide-react";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";
import { cn } from "@/lib/utils";

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
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/services`, {
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { serviceIds?: string[]; panels?: ServicePanel[] };
        setServiceIds(data.serviceIds ?? []);
        setPanels(data.panels ?? []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load services");
      } finally {
        setLoading(false);
      }
    })();
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

  if (serviceIds.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <Server className="size-10 text-muted-foreground/30" />
        <div>
          <p className="text-sm text-muted-foreground">No services running</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Runner services provide panels, triggers, and background functionality.
          </p>
        </div>
      </div>
    );
  }

  // Services with panels get rich cards; services without panels get plain cards
  const panelMap = new Map(panels.map((p) => [p.serviceId, p]));
  const allServices = serviceIds.map((id) => ({
    id,
    panel: panelMap.get(id) ?? null,
  }));

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
      {allServices.map(({ id, panel }) => (
        <div
          key={id}
          className={cn(
            "flex flex-col items-center justify-center gap-2 p-4 rounded-lg border",
            "bg-muted/10 border-border/50 hover:bg-muted/20 transition-colors",
          )}
        >
          <div className="flex items-center justify-center size-10 rounded-lg bg-muted/30 border border-border/30">
            {panel ? (
              <DynamicLucideIcon name={panel.icon} className="size-5 text-foreground/70" />
            ) : (
              <Server className="size-5 text-muted-foreground/50" />
            )}
          </div>
          <span className="text-xs font-medium text-foreground/80 text-center truncate w-full">
            {panel?.label ?? id}
          </span>
        </div>
      ))}
    </div>
  );
}
