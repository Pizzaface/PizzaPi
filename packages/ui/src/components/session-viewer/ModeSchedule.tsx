import * as React from "react";
import { CalendarClockIcon, Loader2Icon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { describeSchedule, isScheduledTrigger, scheduleMessage } from "@/components/session-viewer/schedule-summary";

export interface ScheduledInstruction {
  sessionId: string;
  sessionName: string | null;
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
 * disappeared from the surface meant to cancel them.
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
        sessionId: string;
        sessionName?: string | null;
        subscriptionId?: string;
        triggerType: string;
        params?: Record<string, unknown>;
        cwd?: string | null;
        sessionLive?: boolean;
      }>;
    };
    const instructions = (data.schedules ?? [])
      .filter((row) => isScheduledTrigger(row.triggerType))
      .map((row) => ({
        sessionId: row.sessionId,
        sessionName: row.sessionName ?? null,
        subscriptionId: row.subscriptionId,
        triggerType: row.triggerType,
        params: row.params,
        cwd: row.cwd ?? null,
        sessionLive: row.sessionLive,
      }));
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
 * you are not looking at — so a mode that uses it needs somewhere to see and
 * cancel it.
 */
/**
 * Stable identity for a scheduled row.
 *
 * One function so the row key, the in-flight marker and the disabled check
 * cannot disagree — they did, which left legacy entries (no subscriptionId)
 * clickable while a DELETE was already in flight.
 */
function instructionKey(instruction: ScheduledInstruction, index: number): string {
  return instruction.subscriptionId ?? `${instruction.sessionId}:${instruction.triggerType}:${index}`;
}

export function ModeSchedule({
  instructions,
  loading,
  failed = 0,
  sessionNoun,
  onOpenSession,
  onCancel,
}: {
  instructions: ScheduledInstruction[];
  loading?: boolean;
  /** Sessions whose schedule could not be read. */
  failed?: number;
  sessionNoun: string;
  onOpenSession: (sessionId: string) => void;
  onCancel: (instruction: ScheduledInstruction) => void;
}) {
  const [cancelling, setCancelling] = React.useState<string | null>(null);

  const cancel = async (instruction: ScheduledInstruction, index: number) => {
    const key = instructionKey(instruction, index);
    setCancelling(key);
    try {
      await onCancel(instruction);
    } finally {
      setCancelling(null);
    }
  };

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
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <CalendarClockIcon className="size-3.5" /> Scheduled
      </h3>
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
                  <button
                    type="button"
                    onClick={() => onOpenSession(instruction.sessionId)}
                    className="truncate underline-offset-2 hover:underline"
                  >
                    {instruction.sessionName?.trim() || `Untitled ${sessionNoun}`}
                  </button>
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                disabled={cancelling === key}
                onClick={() => void cancel(instruction, i)}
                aria-label={`Cancel ${describeSchedule(instruction.triggerType, instruction.params)}`}
              >
                {cancelling === key ? <Loader2Icon className="size-3.5 animate-spin" /> : <XIcon className="size-3.5" />}
              </Button>
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
