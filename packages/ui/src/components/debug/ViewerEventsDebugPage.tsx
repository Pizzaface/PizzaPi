import * as React from "react";
import { clearViewerDebugEvents, getViewerDebugEvents, subscribeViewerDebugEvents } from "../../lib/viewer-debug-events";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function formatPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }

  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

interface ViewerEventsDebugPageProps {
  embedded?: boolean;
  className?: string;
}

export function ViewerEventsDebugPage({ embedded = false, className }: ViewerEventsDebugPageProps) {
  const events = React.useSyncExternalStore(
    subscribeViewerDebugEvents,
    getViewerDebugEvents,
    getViewerDebugEvents,
  );
  const [copiedEventId, setCopiedEventId] = React.useState<number | null>(null);

  const handleCopy = React.useCallback(async (eventId: number, payload: unknown) => {
    const ok = await copyText(formatPayload(payload));
    if (!ok) return;
    setCopiedEventId(eventId);
    window.setTimeout(() => {
      setCopiedEventId((current) => (current === eventId ? null : current));
    }, 1500);
  }, []);

  return (
    <div className={cn(
      embedded
        ? "flex h-full min-h-0 flex-col bg-background text-foreground"
        : "min-h-[100dvh] bg-background text-foreground",
      className,
    )}>
      <div className={cn(
        embedded
          ? "flex min-h-0 flex-1 flex-col gap-4 p-4"
          : "mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6",
      )}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Viewer Event Debugger</h1>
            <p className="text-sm text-muted-foreground">
              Raw viewer/service/sigil events captured in this tab.
            </p>
          </div>
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-sm"
            onClick={() => clearViewerDebugEvents()}
          >
            Clear
          </button>
        </div>

        {events.length === 0 ? (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">
            No events captured yet.
          </div>
        ) : (
          <div className={cn("space-y-3", embedded && "min-h-0 flex-1 overflow-y-auto pr-1")}>
            {[...events].reverse().map((event, index) => {
              const payloadText = formatPayload(event.payload);
              return (
                <details key={event.id} className="rounded-lg border bg-card/40" open={index < 3}>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{formatTime(event.at)}</span>
                        <span>•</span>
                        <span>{event.source}</span>
                        <span>•</span>
                        <span className="font-medium text-foreground">{event.type}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">Click to expand payload</div>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 rounded-md border px-2 py-1 text-xs"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void handleCopy(event.id, event.payload);
                      }}
                    >
                      {copiedEventId === event.id ? "Copied" : "Copy JSON"}
                    </button>
                  </summary>
                  <div className="px-3 pb-3">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-3 text-xs">
                      {payloadText}
                    </pre>
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
