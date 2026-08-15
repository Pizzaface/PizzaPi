import * as React from "react";
import { DownloadIcon, ExternalLinkIcon, Loader2Icon, Maximize2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { MessageResponse } from "@/components/ai-elements/message";
import { DynamicLucideIcon } from "@/components/service-panels/lucide-icon";
import { formatSize } from "@/components/file-explorer/utils";
import { CsvTable } from "@/components/session-viewer/csv-table";
import type { ArtifactKind } from "@/components/session-viewer/artifact-detection";

/** Icon per artifact kind, so a deliverable is identifiable before it loads. */
const KIND_ICON: Record<ArtifactKind, string> = {
  markdown: "file-text",
  image: "image",
  pdf: "file-type-2",
  csv: "table",
  xlsx: "sheet",
  html: "code",
  pptx: "presentation",
  download: "file",
};

/** Lazy so SheetJS's parser stays out of the main bundle until a sheet is viewed. */
const XlsxPreview = React.lazy(() => import("@/components/session-viewer/XlsxPreview"));
/** Lazy so the pptx renderer stays out of the main bundle until a deck is viewed. */
const PptxPreview = React.lazy(() => import("@/components/session-viewer/PptxPreview"));

/** Text kinds are fetched as utf8; everything else needs base64. */
function encodingFor(kind: ArtifactKind): "utf8" | "base64" {
  // xlsx is binary; everything but text kinds needs base64.
  return kind === "markdown" || kind === "csv" || kind === "html" ? "utf8" : "base64";
}

const MIME_BY_KIND: Partial<Record<ArtifactKind, string>> = { pdf: "application/pdf" };

function mimeFor(kind: ArtifactKind, path: string): string {
  if (MIME_BY_KIND[kind]) return MIME_BY_KIND[kind]!;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (kind === "image") return ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  return "application/octet-stream";
}

/**
 * Resolve a deliverable path for the read-file API, which takes paths verbatim
 * (no cwd resolution). A model can present a relative path — join it to the
 * session cwd so the file actually loads. POSIX runners only; a Windows drive
 * or UNC path is already absolute.
 */
export function resolveArtifactPath(path: string, cwd: string | undefined): string {
  if (/^([/\\]|[a-zA-Z]:[/\\])/.test(path)) return path;
  if (!cwd) return path;
  return `${cwd.replace(/[/\\]+$/, "")}/${path}`;
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
  title,
  runnerId,
  cwd,
  onOpen,
  onExpand,
}: {
  path: string;
  kind: ArtifactKind;
  /** Human label from an explicit hand-off; falls back to the filename. */
  title?: string;
  /** Runner that owns the file; without it the card cannot fetch a preview. */
  runnerId?: string;
  /** Session cwd, used to resolve a relative deliverable path. */
  cwd?: string;
  /** Open the file in the file explorer panel, when the host supports it. */
  onOpen?: (path: string) => void;
  /**
   * Open this one artifact in the host's docked side panel. When provided the
   * expand affordance uses it (Claude-style side view) instead of the inline
   * fallback dialog. Path is already cwd-resolved.
   */
  onExpand?: (artifact: { path: string; kind: ArtifactKind; title?: string }) => void;
}) {
  const resolvedPath = resolveArtifactPath(path, cwd);
  const fileName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const previewable = kind !== "download";

  const { content, dataUrl, size, error: fetchError, loading, truncated } = useArtifactContent(
    resolvedPath,
    kind,
    runnerId,
    previewable,
  );
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const [downloading, setDownloading] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const error = fetchError ?? downloadError;

  // Prefer the host's docked side panel; fall back to an inline dialog only
  // when no host handler is wired (e.g. isolated render contexts).
  const openViewer = React.useCallback(() => {
    if (onExpand) onExpand({ path: resolvedPath, kind, title });
    else setExpanded(true);
  }, [onExpand, resolvedPath, kind, title]);

  const download = () =>
    downloadArtifact({
      path: resolvedPath,
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
          onClick={openViewer}
          aria-label={`Expand ${fileName}`}
        >
          <Maximize2Icon className="size-3.5" />
        </Button>
      )}
      {onOpen && (
        <Button size="icon" variant="ghost" className="size-7" onClick={() => onOpen(resolvedPath)} aria-label={`Open ${fileName}`}>
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
              "flex min-w-0 items-baseline gap-1.5 text-left",
              previewable && runnerId && "hover:underline cursor-pointer",
            )}
            title={resolvedPath}
            onClick={previewable && runnerId ? openViewer : undefined}
            disabled={!(previewable && runnerId)}
          >
            <span className="truncate text-sm font-medium">{title ?? fileName}</span>
            {title && <span className="shrink-0 truncate text-[0.7rem] text-muted-foreground">{fileName}</span>}
          </button>
          {size !== undefined && <span className="shrink-0 text-[0.65rem] tabular-nums text-muted-foreground">{formatSize(size)}</span>}
          {actions}
        </div>

        <div className={cn("max-h-96 overflow-auto", (kind === "pdf" || kind === "xlsx" || kind === "pptx") && "max-h-none")}>
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
                  onClick={openViewer}
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
          path={resolvedPath}
          kind={kind}
          title={title}
          runnerId={runnerId}
          onOpen={onOpen}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}

/**
 * A deliverable shown large — header + full preview, filling its container.
 *
 * Rendered as the host's docked side panel (Claude-style, one artifact at a
 * time) and, as a fallback, inside a dialog. Refetches its own content so the
 * viewer works even when the inline preview was truncated.
 */
export function ArtifactViewerContent({
  path,
  kind,
  title,
  runnerId,
  onOpen,
  onClose,
}: {
  path: string;
  kind: ArtifactKind;
  title?: string;
  runnerId?: string;
  onOpen?: (path: string) => void;
  /** When provided, renders a close button (dialog use); the docked panel
   * relies on its own tab chrome and omits this. */
  onClose?: () => void;
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
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <DynamicLucideIcon name={KIND_ICON[kind]} className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium" title={path}>
          {title ?? fileName}
        </span>
        {title && <span className="shrink-0 truncate text-xs text-muted-foreground">{fileName}</span>}
        {size !== undefined && <span className="shrink-0 text-[0.65rem] tabular-nums text-muted-foreground">{formatSize(size)}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {onOpen && (
            <Button size="icon" variant="ghost" className="size-7" onClick={() => onOpen(path)} aria-label={`Open ${fileName}`}>
              <ExternalLinkIcon className="size-4" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            onClick={() => void download()}
            disabled={downloading}
            aria-label={`Download ${fileName}`}
          >
            {downloading ? <Loader2Icon className="size-4 animate-spin" /> : <DownloadIcon className="size-4" />}
          </Button>
          {onClose && (
            <Button size="icon" variant="ghost" className="size-7" onClick={onClose} aria-label="Close">
              <span className="text-lg leading-none">×</span>
            </Button>
          )}
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
    </div>
  );
}

/** Inline fallback: the viewer in a centered dialog (used when the host has no
 * docked panel to open the artifact into). */
function ArtifactViewer({
  path,
  kind,
  title,
  runnerId,
  onOpen,
  onClose,
}: {
  path: string;
  kind: ArtifactKind;
  title?: string;
  runnerId?: string;
  onOpen?: (path: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="h-[90vh] w-[min(1100px,95vw)] max-w-[95vw] gap-0 p-0"
        aria-describedby={undefined}
      >
        <ArtifactViewerContent path={path} kind={kind} title={title} runnerId={runnerId} onOpen={onOpen} onClose={onClose} />
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

  if (kind === "csv") return <CsvTable content={content} full={full} />;

  if (kind === "xlsx") {
    return (
      <React.Suspense
        fallback={
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Loading sheet…
          </div>
        }
      >
        <XlsxPreview content={content} full={full} />
      </React.Suspense>
    );
  }

  if (kind === "pptx") {
    return (
      <React.Suspense
        fallback={
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Loading slides…
          </div>
        }
      >
        <div className={full ? "h-full" : "h-[28rem]"}>
          <PptxPreview content={content} full={full} />
        </div>
      </React.Suspense>
    );
  }

  return null;
}
