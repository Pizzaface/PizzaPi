import { CalendarClockIcon, Loader2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { describeSchedule, isScheduledTrigger, scheduleMessage } from "@/components/session-viewer/schedule-summary";

export interface ScheduledInstruction {
  sessionId?: string;
  sessionName: string | null;
  target?:
    | { kind: "session"; sessionId: string; runnerId?: string }
    | { kind: "spawn"; spec: { runnerId: string; cwd?: string } };
  runnerId?: string;
  subscriptionId?: string;
  triggerType: string;
  params?: Record<string, unknown>;
  /** Workspace the schedule belongs to, used to place it in a mode. */
  cwd?: string | null;
  /** False when the owning worker has exited — the schedule still fires. */
  sessionLive?: boolean;
}

/**
 * Fetch every standing schedule on a runner.
 *
 * Schedules belong to a runner and outlive the sessions that create them, so
 * they are fetched by runner rather than by fanning out over sessions. The old
 * fan-out could only see a schedule whose owning session happened to be in the
 * page of sessions being listed, so old and ownerless schedules silently
 * disappeared from the mode preview.
 */
export async function fetchScheduledInstructions(
  runnerId: string | null | undefined,
  signal?: AbortSignal,
): Promise<{ instructions: ScheduledInstruction[]; failed: number }> {
  if (!runnerId) return { instructions: [], failed: 0 };
  try {
    const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/schedules`, {
      credentials: "include",
      signal,
    });
    if (!res.ok) return { instructions: [], failed: 1 };
    const data = (await res.json()) as {
      schedules?: Array<{
        sessionId?: string;
        sessionName?: string | null;
        target?:
          | { kind: "session"; sessionId: string; runnerId?: string }
          | { kind: "spawn"; spec: { runnerId: string; cwd?: string } };
        runnerId?: string;
        subscriptionId?: string;
        triggerType: string;
        params?: Record<string, unknown>;
        cwd?: string | null;
        sessionLive?: boolean;
      }>;
    };
    const instructions = (data.schedules ?? [])
      .filter((row) => isScheduledTrigger(row.triggerType))
      .map((row) => {
        const sessionId = row.sessionId || (row.target?.kind === "session" ? row.target.sessionId : undefined);
        const runnerId = row.runnerId ?? (row.target?.kind === "spawn" ? row.target.spec.runnerId : row.target?.runnerId);
        return {
          ...(sessionId ? { sessionId } : {}),
          sessionName: row.sessionName ?? null,
          ...(row.target ? { target: row.target } : {}),
          ...(runnerId ? { runnerId } : {}),
          subscriptionId: row.subscriptionId,
          triggerType: row.triggerType,
          params: row.params,
          cwd: row.target?.kind === "spawn" ? row.target.spec.cwd ?? row.cwd ?? null : row.cwd ?? null,
          sessionLive: row.sessionLive,
        };
      });
    return { instructions, failed: 0 };
  } catch {
    // A failed load is reported rather than passed off as "nothing scheduled".
    if (signal?.aborted) return { instructions: [], failed: 0 };
    return { instructions: [], failed: 1 };
  }
}

/**
 * Standing instructions for a mode: what runs on a schedule, and where.
 *
 * Scheduled work is invisible in a chat transcript — it fires into a session
 * you are not looking at — so a mode that uses it needs somewhere to see it.
 */
/** Stable identity for a scheduled row, including legacy entries without subscription ids. */
function instructionKey(instruction: ScheduledInstruction, index: number): string {
  return instruction.subscriptionId ?? `${instruction.sessionId ?? instruction.runnerId ?? instruction.target?.kind}:${instruction.triggerType}:${index}`;
}

export function ModeSchedule({
  instructions,
  loading,
  failed = 0,
  sessionNoun,
  onOpenSession,
  onOpenTriggerManager,
}: {
  instructions: ScheduledInstruction[];
  loading?: boolean;
  /** Sessions whose schedule could not be read. */
  failed?: number;
  sessionNoun: string;
  onOpenSession: (sessionId: string) => void;
  onOpenTriggerManager?: () => void;
}) {

  if (loading) {
    return (
      <div className="mt-8 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" /> Checking scheduled work…
      </div>
    );
  }

  if (instructions.length === 0 && failed === 0) return null;

  if (instructions.length === 0) {
    return (
      <div className="mt-8 text-xs text-muted-foreground">
        Could not check scheduled work for {failed} {failed === 1 ? sessionNoun : `${sessionNoun}s`}.
      </div>
    );
  }

  return (
    <div className="mt-8">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <CalendarClockIcon className="size-3.5" /> Scheduled
        </h3>
        {onOpenTriggerManager && <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onOpenTriggerManager}>Manage triggers</Button>}
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        {instructions.map((instruction, i) => {
          const key = instructionKey(instruction, i);
          const message = scheduleMessage(instruction.params);
          return (
            <div key={key} className={cn("flex items-center gap-3 px-3 py-2", i > 0 && "border-t border-border")}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{message ?? `Wakes this ${sessionNoun}`}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[0.65rem] text-muted-foreground">
                  <span>{describeSchedule(instruction.triggerType, instruction.params)}</span>
                  <span aria-hidden="true">·</span>
                  {instruction.target?.kind === "spawn" ? (
                    <span>Spawns on {instruction.target.spec.runnerId}</span>
                  ) : instruction.sessionId ? (
                    <button
                      type="button"
                      onClick={() => onOpenSession(instruction.sessionId!)}
                      className="truncate underline-offset-2 hover:underline"
                    >
                      {instruction.sessionName?.trim() || `Untitled ${sessionNoun}`}
                    </button>
                  ) : instruction.runnerId ? (
                    <span>Spawns on {instruction.runnerId}</span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {failed > 0 && (
        <p className="mt-1.5 text-[0.65rem] text-muted-foreground">
          Could not check {failed} more {failed === 1 ? sessionNoun : `${sessionNoun}s`} — this list may be incomplete.
        </p>
      )}
    </div>
  );
}
