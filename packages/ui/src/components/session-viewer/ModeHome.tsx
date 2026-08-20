import * as React from "react";
import { ArrowUpIcon, Loader2Icon } from "lucide-react";
import type { ResolvedModeUi, ServiceModeSuggestion } from "@pizzapi/protocol";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";
import { ModeSchedule, type ScheduledInstruction } from "@/components/session-viewer/ModeSchedule";

export interface ModeHomeSession {
  sessionId: string;
  sessionName: string | null;
  cwd: string;
  lastHeartbeatAt: string | null;
  startedAt: string;
  isActive: boolean;
}

/**
 * Composer-first landing for a session mode.
 *
 * Selecting a mode should offer to start work, not show an empty transcript
 * telling you to pick a session. The composer starts a task directly in the
 * mode's workspace; suggestions are declared by the mode's package.
 */
export function ModeHome({
  modeLabel,
  modeIcon,
  modeUi,
  recentSessions,
  onStartTask,
  onOpenSession,
  busy,
  scheduled,
}: {
  modeLabel: string;
  modeIcon?: string;
  modeUi: ResolvedModeUi;
  recentSessions: ModeHomeSession[];
  /** Start a task in this mode with the given prompt (may be empty). */
  onStartTask: (prompt: string) => void | Promise<void>;
  onOpenSession: (sessionId: string) => void;
  /** A task is being started — the composer is locked until it resolves. */
  busy?: boolean;
  /** Standing scheduled work, when the mode declares `scheduled`. */
  scheduled?: {
    instructions: ScheduledInstruction[];
    loading?: boolean;
    failed?: number;
    onCancel: (instruction: ScheduledInstruction) => void;
  };
}) {
  const [draft, setDraft] = React.useState("");
  const [startError, setStartError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  const submit = async () => {
    if (busy) return;
    const text = draft.trim();
    if (!text) return;
    // The draft is kept, not cleared: a successful start opens the new task and
    // unmounts this view, while a failed one would otherwise throw away what
    // the user typed.
    setStartError(null);
    try {
      await Promise.resolve(onStartTask(text));
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Failed to start task");
    }
  };

  const chooseSuggestion = (suggestion: ServiceModeSuggestion) => {
    // Prefill rather than send: suggestions are openings ("Research ..."),
    // and sending them verbatim would start work on a half-written request.
    setDraft(suggestion.prompt);
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-2.5">
          {modeIcon && (
            <span
              className="flex size-9 items-center justify-center rounded-lg border"
              style={modeUi.accent ? { borderColor: `${modeUi.accent}59`, backgroundColor: `${modeUi.accent}14`, color: modeUi.accent } : undefined}
            >
              <DynamicLucideIcon name={modeIcon} className="size-4.5" />
            </span>
          )}
          <div>
            <h2 className="text-lg font-semibold leading-tight">{modeUi.greeting ?? `${modeLabel}`}</h2>
            <p className="text-xs text-muted-foreground">
              Starts a new {modeUi.sessionNoun} in {modeLabel}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-2 shadow-sm focus-within:border-ring/60">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={3}
            disabled={busy}
            placeholder={modeUi.composerPlaceholder ?? `Start a ${modeUi.sessionNoun}…`}
            aria-label={`Start a ${modeUi.sessionNoun}`}
            className="w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
          />
          <div className="flex items-center justify-end gap-2 px-1 pb-0.5">
            <Button size="sm" onClick={submit} disabled={busy || draft.trim().length === 0}>
              {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <ArrowUpIcon className="size-3.5" />}
              {modeUi.newSessionLabel}
            </Button>
          </div>
        </div>

        {startError && <p role="alert" className="mt-2 text-xs text-destructive">{startError}</p>}

        {modeUi.suggestions.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {modeUi.suggestions.map((suggestion, i) => (
              <button
                key={`${suggestion.label}-${i}`}
                type="button"
                onClick={() => chooseSuggestion(suggestion)}
                disabled={busy}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs",
                  "text-foreground/80 transition-colors hover:bg-muted disabled:opacity-60",
                )}
              >
                {suggestion.icon && <DynamicLucideIcon name={suggestion.icon} className="size-3.5 text-muted-foreground" />}
                {suggestion.label}
              </button>
            ))}
          </div>
        )}

        {modeUi.scheduled && scheduled && (
          <ModeSchedule
            instructions={scheduled.instructions}
            loading={scheduled.loading}
            failed={scheduled.failed}
            sessionNoun={modeUi.sessionNoun}
            onOpenSession={onOpenSession}
            onCancel={scheduled.onCancel}
          />
        )}

        {modeUi.recent && recentSessions.length > 0 && (
          <div className="mt-8">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent {modeUi.sessionNounPlural}
            </h3>
            <div className="overflow-hidden rounded-lg border border-border">
              {recentSessions.map((session, i) => (
                <button
                  key={session.sessionId}
                  type="button"
                  onClick={() => onOpenSession(session.sessionId)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60",
                    i > 0 && "border-t border-border",
                  )}
                >
                  <span
                    className={cn("size-1.5 shrink-0 rounded-full", session.isActive ? "bg-emerald-500" : "bg-muted-foreground/40")}
                    aria-hidden="true"
                  />
                  <span className="truncate">{session.sessionName?.trim() || `Untitled ${modeUi.sessionNoun}`}</span>
                  <span className="ml-auto shrink-0 text-[0.65rem] text-muted-foreground">
                    {formatWhen(session.lastHeartbeatAt ?? session.startedAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Compact relative time for the recent list. */
export function formatWhen(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(then).toLocaleDateString();
}
