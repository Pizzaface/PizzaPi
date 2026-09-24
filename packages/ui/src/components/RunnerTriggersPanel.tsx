import * as React from "react";
import { EventsRoutesPanel } from "@/components/events/EventsRoutesPanel";

export interface RunnerTriggersPanelProps {
  runnerId: string;
  sessions?: Array<{ sessionId: string; sessionName?: string | null; runnerId?: string | null }>;
  runners?: Array<{ runnerId: string; name?: string | null }>;
  onOpenSession?: (sessionId: string) => void;
}

/** Runner-wide route manager. Kept at the established mount point for compatibility. */
export function RunnerTriggersPanel({ runnerId, sessions, runners, onOpenSession }: RunnerTriggersPanelProps) {
  const runnerSessions = sessions?.filter((session) => session.runnerId === runnerId);
  const orderedRunners = runners?.slice().sort(
    (a, b) => Number(b.runnerId === runnerId) - Number(a.runnerId === runnerId),
  );
  return <EventsRoutesPanel bare runnerId={runnerId} sessions={runnerSessions} runners={orderedRunners} onOpenSession={onOpenSession} />;
}
