import * as React from "react";
import type { ServicePanelInfo } from "@pizzapi/protocol";
import { X, Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";
import { IframeServicePanel } from "@/components/service-panels/IframeServicePanel";

/** Full-screen surface for a session-list launcher panel (e.g. PizzaWork Schedules). */
export interface LauncherPanelViewProps {
  panelId: string;
  panels: ServicePanelInfo[];
  runnerId: string | null;
  onClose: () => void;
}

export function LauncherPanelView({ panelId, panels, runnerId, onClose }: LauncherPanelViewProps) {
  const panel = React.useMemo(() => panels.find((p) => p.serviceId === panelId), [panelId, panels]);
  if (!panel || !runnerId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <p className="text-sm">Launcher panel unavailable.</p>
        <Button variant="ghost" size="sm" onClick={onClose}>Back to sessions</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col h-full min-h-0 bg-background">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          {panel.icon ? <DynamicLucideIcon name={panel.icon} className="h-4 w-4" /> : <Briefcase className="h-4 w-4" />}
          {panel.label}
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close schedule viewer">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 min-h-0">
        <IframeServicePanel
          sessionId=""
          runnerId={runnerId}
          port={panel.port}
          panelParams={panel.panelParams}
          cwd={panel.panelParams?.projectDir}
        />
      </div>
    </div>
  );
}
