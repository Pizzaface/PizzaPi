import * as React from "react";
import { DownloadIcon, ExternalLinkIcon, Loader2Icon, Maximize2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { MessageResponse } from "@/components/ai-elements/message";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";
import { formatSize } from "@/components/file-explorer/utils";
import { parseCsv } from "@/components/session-viewer/csv";
import type { ArtifactKind } from "@/components/session-viewer/artifact-detection";

/** Icon per artifact kind, so a deliverable is identifiable before it loads. */
const KIND_ICON: Record<ArtifactKind, string> = {
  markdown: "file-text",
  image: "image",
  pdf: "file-type-2",
  csv: "table",
  html: "code",
  download: "file",
};

/** Text kinds are fetched as utf8; everything else needs base64. */
function encodingFor(kind: ArtifactKind): "utf8" | "base64" {
  return kind === "markdown" || kind === "csv" || kind === "html" ? "utf8" : "base64";
}

const MIME_BY_KIND: Partial<Record<ArtifactKind, string>> = { pdf: "application/pdf" };

function mimeFor(kind: ArtifactKind, path: string): string {
  if (MIME_BY_KIND[kind]) return MIME_BY_KIND[kind]!;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (kind === "image") return ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  return "application/octet-stream";
}

/** Bytes read from a runner file, plus the state around loading them. */
interface ArtifactContent {
  content: string | null;
  dataUrl: string | null;
  size: number | undefined;
  error: string | null;
  loading: boolean;
  /** A preview may be a prefix of the file (text capped at 512 KiB, binary 10 MiB). */
  truncated: boolean;
}

/**
 * Fetch a runner file's contents once, lazily.
 *
 * Shared by the inline card and the expanded viewer so a deliverable is never
 * fetched twice for the same view, and both render identically.
 */
function useArtifactContent(
  path: string,
  kind: ArtifactKind,
  runnerId: string | undefined,
  enabled: boolean,
): ArtifactContent {
  const [content, setContent] = React.useState<string | null>(null);
  const [size, setSize] = React.useState<number | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [truncated, setTruncated] = React.useState(false);

  React.useEffect(() => {
    if (!runnerId || !enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void fetch(`/api/runners/${encodeURIComponent(runnerId)}/read-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      signal: controller.signal,
      body: JSON.stringify({ path, encoding: encodingFor(kind) }),
    })
      .then((res) => (res.ok ? res.json() : res.json().then((d: any) => Promise.reject(new Error(d.error || `HTTP ${res.status}`)))))
      .then((data: any) => {
        if (controller.signal.aborted) return;
        setContent(typeof data.content === "string" ? data.content : "");
        setTruncated(data.truncated === true);
        if (typeof data.size === "number") setSize(data.size);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [runnerId, path, kind, enabled]);

  const dataUrl = React.useMemo(
    () => (content && encodingFor(kind) === "base64" ? `data:${mimeFor(kind, path)};base64,${content}` : null),
    [content, kind, path],
  );

  return { content, dataUrl, size, error, loading, truncated };
}

/**
 * Download a deliverable, fetching whole-file bytes when the loaded preview is
 * only a prefix. Never builds a download from a truncated preview — a partial
 * docx/pptx/pdf is a corrupt file, not a partial one.
 */
async function downloadArtifact(opts: {
  path: string;
  kind: ArtifactKind;
  runnerId: string | undefined;
  fileName: string;
  content: string | null;
  dataUrl: string | null;
  truncated: boolean;
  onError: (message: string) => void;
  setBusy: (busy: boolean) => void;
}): Promise<void> {
  const { path, kind, runnerId, fileName, content, dataUrl, truncated, onError, setBusy } = opts;

  let href = !truncated ? dataUrl : null;
  if (!href && !truncated && content !== null && encodingFor(kind) === "utf8") {
    href = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;
  }

  if (!href) {
    if (!runnerId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/read-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ path, encoding: "base64", rejectTruncated: true }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { content?: string };
      if (!data.content) throw new Error("empty response");
      href = `data:application/octet-stream;base64,${data.content}`;
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : String(err));
      return;
    } finally {
      setBusy(false);
    }
  }

  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  a.click();
}

/**
 * A deliverable produced by the session, rendered inline.
 *
 * Work-shaped modes exist to produce documents, so the document is the point
 * of the message — not a file-write buried in a tool card. Content is fetched
 * lazily on first render. A previewable artifact can be expanded into a large
 * viewer for a proper read.
 */
export function ArtifactCard({
  path,
  kind,
  runnerId,
  onOpen,
}: {
  path: string;
  kind: ArtifactKind;
  /** Runner that owns the file; without it the card cannot fetch a preview. */
  runnerId?: string;
  /** Open the file in the file explorer panel, when the host supports it. */
  onOpen?: (path: string) => void;
}) {
  const fileName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const previewable = kind !== "download";

  const { content, dataUrl, size, error: fetchError, loading, truncated } = useArtifactContent(
    path,
    kind,
    runnerId,
    previewable,
  );
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const [downloading, setDownloading] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const error = fetchError ?? downloadError;

  const download = () =>
    downloadArtifact({
      path,
      kind,
      runnerId,
      fileName,
      content,
      dataUrl,
      truncated,
      onError: setDownloadError,
      setBusy: setDownloading,
    });

  const actions = (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {previewable && runnerId && (
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={() => setExpanded(true)}
          aria-label={`Expand ${fileName}`}
        >
          <Maximize2Icon className="size-3.5" />
        </Button>
      )}
      {onOpen && (
        <Button size="icon" variant="ghost" className="size-7" onClick={() => onOpen(path)} aria-label={`Open ${fileName}`}>
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      )}
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        onClick={() => void download()}
        disabled={downloading || (!runnerId && content === null)}
        aria-label={`Download ${fileName}`}
      >
        {downloading ? <Loader2Icon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5" />}
      </Button>
    </div>
  );

  return (
    <>
      <div className="my-2 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
          <DynamicLucideIcon name={KIND_ICON[kind]} className="size-4 shrink-0 text-muted-foreground" />
          <button
            type="button"
            className={cn(
              "truncate text-left text-sm font-medium",
              previewable && runnerId && "hover:underline cursor-pointer",
            )}
            title={path}
            onClick={previewable && runnerId ? () => setExpanded(true) : undefined}
            disabled={!(previewable && runnerId)}
          >
            {fileName}
          </button>
          {size !== undefined && <span className="shrink-0 text-[0.65rem] tabular-nums text-muted-foreground">{formatSize(size)}</span>}
          {actions}
        </div>

        <div className={cn("max-h-96 overflow-auto", kind === "pdf" && "max-h-none")}>
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" /> Loading preview…
            </div>
          )}

          {!loading && error && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">Preview unavailable — {error}</div>
          )}

          {!loading && !error && !previewable && (
            <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-muted-foreground">
              <DynamicLucideIcon name={KIND_ICON[kind]} className="size-8 text-muted-foreground/60" />
              <span>{fileName.split(".").pop()?.toUpperCase()} file — download to open.</span>
            </div>
          )}

          {!loading && !error && !runnerId && previewable && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">No runner available to load this file.</div>
          )}

          {!loading && !error && content !== null && (
            <>
              <ArtifactPreview kind={kind} content={content} dataUrl={dataUrl} fileName={fileName} />
              {truncated && (
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="w-full border-t border-border px-3 py-1.5 text-center text-[0.65rem] text-muted-foreground hover:bg-muted/40"
                >
                  Preview shows the start of this file — expand or download for the whole thing.
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {expanded && (
        <ArtifactViewer
          path={path}
          kind={kind}
          runnerId={runnerId}
          onOpen={onOpen}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}

/**
 * A deliverable shown large, in a focused overlay beside the transcript.
 *
 * Refetches its own content so opening the viewer works even when the inline
 * preview was truncated — the viewer is where a full read happens.
 */
function ArtifactViewer({
  path,
  kind,
  runnerId,
  onOpen,
  onClose,
}: {
  path: string;
  kind: ArtifactKind;
  runnerId?: string;
  onOpen?: (path: string) => void;
  onClose: () => void;
}) {
  const fileName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const { content, dataUrl, size, error, loading, truncated } = useArtifactContent(path, kind, runnerId, true);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const [downloading, setDownloading] = React.useState(false);

  const download = () =>
    downloadArtifact({
      path,
      kind,
      runnerId,
      fileName,
      content,
      dataUrl,
      truncated,
      onError: setDownloadError,
      setBusy: setDownloading,
    });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[90vh] w-[min(1100px,95vw)] max-w-[95vw] flex-col gap-0 p-0"
        aria-describedby={undefined}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <DynamicLucideIcon name={KIND_ICON[kind]} className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium" title={path}>
            {fileName}
          </span>
          {size !== undefined && <span className="shrink-0 text-[0.65rem] tabular-nums text-muted-foreground">{formatSize(size)}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onOpen && (
              <Button size="icon" variant="ghost" className="size-8" onClick={() => onOpen(path)} aria-label={`Open ${fileName}`}>
                <ExternalLinkIcon className="size-4" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={() => void download()}
              disabled={downloading}
              aria-label={`Download ${fileName}`}
            >
              {downloading ? <Loader2Icon className="size-4 animate-spin" /> : <DownloadIcon className="size-4" />}
            </Button>
            <Button size="icon" variant="ghost" className="size-8" onClick={onClose} aria-label="Close">
              <span className="text-lg leading-none">×</span>
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {loading && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {!loading && error && (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
              Unavailable — {error}
            </div>
          )}
          {!loading && !error && content !== null && (
            <ArtifactPreview kind={kind} content={content} dataUrl={dataUrl} fileName={fileName} full />
          )}
          {(downloadError && !error) && (
            <div className="border-t border-border px-4 py-1.5 text-center text-[0.65rem] text-destructive">
              Download failed — {downloadError}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ArtifactPreview({
  kind,
  content,
  dataUrl,
  fileName,
  full = false,
}: {
  kind: ArtifactKind;
  content: string;
  dataUrl: string | null;
  fileName: string;
  /** Fill the available space rather than the compact inline caps. */
  full?: boolean;
}) {
  if (kind === "markdown") {
    return (
      <div className={cn("px-4 py-3", full && "mx-auto max-w-3xl px-6 py-6")}>
        <MessageResponse>{content}</MessageResponse>
      </div>
    );
  }

  if (kind === "image" && dataUrl) {
    return (
      <div className={cn("flex justify-center bg-muted/20 p-3", full && "h-full items-center p-6")}>
        <img src={dataUrl} alt={fileName} className={cn("max-w-full object-contain", full ? "max-h-full" : "max-h-80")} />
      </div>
    );
  }

  if (kind === "pdf" && dataUrl) {
    return <iframe src={dataUrl} title={fileName} className={cn("w-full border-0", full ? "h-full" : "h-[32rem]")} />;
  }

  if (kind === "html") {
    return (
      <iframe
        // Untrusted generated markup: no same-origin, no scripts, so a
        // deliverable can never reach the session it was produced in.
        sandbox=""
        srcDoc={content}
        title={fileName}
        className={cn("w-full border-0 bg-white", full ? "h-full" : "h-96")}
      />
    );
  }

  if (kind === "csv") return <CsvPreview content={content} full={full} />;

  return null;
}

/** First rows of a CSV/TSV, as a table. */
function CsvPreview({ content, full = false }: { content: string; full?: boolean }) {
  const { header, rows, truncated } = React.useMemo(() => parseCsv(content, full ? 500 : 50), [content, full]);
  if (!header) return <div className="px-3 py-6 text-center text-sm text-muted-foreground">Empty file.</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted/60">
          <tr>
            {header.map((cell, i) => (
              <th key={i} className="border-b border-border px-2 py-1.5 text-left font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="odd:bg-muted/20">
              {header.map((_, c) => (
                <td key={c} className="border-b border-border/50 px-2 py-1 tabular-nums">
                  {row[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <div className="px-3 py-2 text-center text-[0.65rem] text-muted-foreground">Showing the first {rows.length} rows.</div>}
    </div>
  );
}
