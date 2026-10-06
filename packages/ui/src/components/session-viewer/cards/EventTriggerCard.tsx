import * as React from "react";
import { Zap } from "lucide-react";
import { ToolCardShell, ToolCardHeader, ToolCardTitle, ToolCardSection, StatusPill } from "@/components/ui/tool-card";
import type { ParsedTrigger } from "./trigger-parsers";

const PAGE_SIZE = 32;
const PREVIEW_SUFFIX = "… [preview truncated]";
const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, Math.max(0, limit - PREVIEW_SUFFIX.length))}${PREVIEW_SUFFIX}` : text;

/** A bounded display preview, not a replacement for the stored original payload. */
function payloadPreview(value: unknown): string {
  if (typeof value === "string") return clip(value, 512);
  let remaining = 128;
  const ancestors = new WeakSet<object>();
  const bounded = (data: unknown, depth: number): unknown => {
    if (--remaining < 0) return "[Preview node limit]";
    if (typeof data === "string") return clip(data, 512);
    if (typeof data === "function" || typeof data === "symbol" || typeof data === "bigint") return `[Unsupported ${typeof data}]`;
    if (data === null || typeof data !== "object") return data;
    if (depth >= 5) return "[Preview depth limit]";
    if (ancestors.has(data)) return "[Circular reference]";
    ancestors.add(data);
    let result: unknown;
    if (Array.isArray(data)) {
      const items: unknown[] = [];
      for (const item of data.slice(0, PAGE_SIZE)) {
        if (remaining <= 0) break;
        items.push(bounded(item, depth + 1));
      }
      if (items.length < data.length) items.push("[Additional data omitted]");
      result = items;
    } else {
      const fields: Record<string, unknown> = Object.create(null);
      const keys = Object.keys(data);
      let count = 0;
      for (const key of keys.slice(0, PAGE_SIZE)) {
        if (remaining <= 0) break;
        fields[clip(key, 128)] = bounded((data as Record<string, unknown>)[key], depth + 1);
        count++;
      }
      if (count < keys.length) fields["…"] = "[Additional data omitted]";
      result = fields;
    }
    ancestors.delete(data);
    return result;
  };
  try {
    return clip(JSON.stringify(bounded(value, 0), null, 2) ?? String(value), 4_096);
  } catch {
    return "[Unserializable value]";
  }
}

function PayloadValue({ value }: { value: unknown }) {
  const [expanded, setExpanded] = React.useState(false);
  const preview = React.useMemo(() => expanded ? payloadPreview(value) : undefined, [expanded, value]);
  if (value !== null && typeof value === "object") {
    return (
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">View data (limited preview)</summary>
        {expanded && <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{preview}</pre>}
      </details>
    );
  }
  if (typeof value === "string" && value.length <= 2_048) {
    let url: URL | undefined;
    try { url = new URL(value); } catch { /* Not an absolute URL — render literally. */ }
    if (url?.protocol === "https:" || url?.protocol === "http:") {
      return <a href={url.href} target="_blank" rel="noopener noreferrer" title={url.href} className="break-all text-sky-400 underline underline-offset-2 hover:text-sky-300">{url.host}</a>;
    }
  }
  return <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{payloadPreview(value)}</span>;
}

/** Human-facing event data only; never render the agent's trigger envelope. */
export function EventTriggerCard({ event }: { event: ParsedTrigger }) {
  const [page, setPage] = React.useState(0);
  const payload = event.payload;
  const objectPayload = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
  const keys = React.useMemo(() => objectPayload ? Object.keys(objectPayload) : undefined, [objectPayload]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil((keys?.length ?? 0) / PAGE_SIZE) - 1));
  const start = currentPage * PAGE_SIZE;
  const fields: Array<[string, unknown]> = keys && objectPayload
    ? keys.slice(start, start + PAGE_SIZE).map((key) => [key, objectPayload[key]])
    : payload === undefined ? [] : [["payload", payload]];
  return (
    <ToolCardShell>
      <ToolCardHeader>
        <ToolCardTitle icon={<Zap className="size-3.5 shrink-0" />}>
          <span className="min-w-0 break-words font-mono text-xs">{clip(event.eventType ?? "Event", 128)}</span>
        </ToolCardTitle>
        {event.expectsResponse && <StatusPill variant="info">Response required</StatusPill>}
      </ToolCardHeader>
      <ToolCardSection>
        {(event.summary || event.sourceName) && <p className="mb-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm font-medium">{clip(event.summary ?? event.sourceName ?? "", 512)}</p>}
        {event.sourceSessionId && <p className="mb-3 break-all text-xs text-muted-foreground">{event.summary && event.sourceName ? `${clip(event.sourceName, 128)} · ` : ""}{clip(event.sourceSessionId, 128)}</p>}
        {fields.length === 0 ? <p className="text-sm text-muted-foreground">No payload fields.</p> : (
          <dl className="space-y-2 text-sm">
            {fields.map(([key, value]) => (
              <div key={key} className="grid grid-cols-[minmax(0,5rem)_minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(0,7rem)_minmax(0,1fr)]">
                <dt className="break-all font-mono text-xs text-muted-foreground">{clip(key, 128)}</dt>
                <dd className="min-w-0"><PayloadValue value={value} /></dd>
              </div>
            ))}
          </dl>
        )}
        {keys && keys.length > PAGE_SIZE && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Fields {start + 1}–{start + fields.length} of {keys.length}</span>
            <button type="button" aria-label="Previous payload fields" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-50">Previous</button>
            <button type="button" aria-label="Next payload fields" disabled={start + PAGE_SIZE >= keys.length} onClick={() => setPage(currentPage + 1)} className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-50">Next</button>
          </div>
        )}
      </ToolCardSection>
    </ToolCardShell>
  );
}
