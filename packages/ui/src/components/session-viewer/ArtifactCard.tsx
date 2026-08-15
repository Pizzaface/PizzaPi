import * as React from "react";
import { DownloadIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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

/**
 * A deliverable produced by the session, rendered inline.
 *
 * Work-shaped modes exist to produce documents, so the document is the point
 * of the message — not a file-write buried in a tool card. Content is fetched
 * lazily on first render so a transcript full of artifacts doesn't fan out
 * into a dozen reads at once.
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
  const [content, setContent] = React.useState<string | null>(null);
  const [size, setSize] = React.useState<number | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const fileName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const previewable = kind !== "download";

  React.useEffect(() => {
    if (!runnerId || !previewable) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    void fetch(`/api/runners/${encodeURIComponent(runnerId)}/read-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ path, encoding: encodingFor(kind) }),
    })
      .then((res) => (res.ok ? res.json() : res.json().then((d: any) => Promise.reject(new Error(d.error || `HTTP ${res.status}`)))))
      .then((data: any) => {
        if (cancelled) return;
        setContent(typeof data.content === "string" ? data.content : "");
        if (typeof data.size === "number") setSize(data.size);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [runnerId, path, kind, previewable]);

  const dataUrl = React.useMemo(
    () => (content && encodingFor(kind) === "base64" ? `data:${mimeFor(kind, path)};base64,${content}` : null),
    [content, kind, path],
  );

  const [downloading, setDownloading] = React.useState(false);

  /**
   * Fetch on demand rather than eagerly: a docx/pptx has no preview, so its
   * bytes are only ever needed if the user actually asks for the file.
   */
  const download = async () => {
    let href = dataUrl;
    if (!href && content !== null && encodingFor(kind) === "utf8") {
      href = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;
    }

    if (!href) {
      if (!runnerId) return;
      setDownloading(true);
      try {
        const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/read-file`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ path, encoding: "base64" }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { content?: string };
        if (!data.content) throw new Error("empty response");
        href = `data:application/octet-stream;base64,${data.content}`;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setDownloading(false);
      }
    }

    const a = document.createElement("a");
    a.href = href;
    a.download = fileName;
    a.click();
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <DynamicLucideIcon name={KIND_ICON[kind]} className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium" title={path}>
          {fileName}
        </span>
        {size !== undefined && <span className="shrink-0 text-[0.65rem] tabular-nums text-muted-foreground">{formatSize(size)}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1">
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
      </div>

      <div className={cn("max-h-96 overflow-auto", kind === "pdf" && "max-h-none")}>
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Loading preview…
          </div>
        )}

        {!loading && error && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            Preview unavailable — {error}
          </div>
        )}

        {!loading && !error && !previewable && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            {fileName.split(".").pop()?.toUpperCase()} file — download to open.
          </div>
        )}

        {!loading && !error && !runnerId && previewable && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">No runner available to load this file.</div>
        )}

        {!loading && !error && content !== null && (
          <ArtifactPreview kind={kind} content={content} dataUrl={dataUrl} fileName={fileName} />
        )}
      </div>
    </div>
  );
}

function ArtifactPreview({
  kind,
  content,
  dataUrl,
  fileName,
}: {
  kind: ArtifactKind;
  content: string;
  dataUrl: string | null;
  fileName: string;
}) {
  if (kind === "markdown") {
    return (
      <div className="px-3 py-2">
        <MessageResponse>{content}</MessageResponse>
      </div>
    );
  }

  if (kind === "image" && dataUrl) {
    return (
      <div className="flex justify-center bg-muted/20 p-3">
        <img src={dataUrl} alt={fileName} className="max-h-80 max-w-full object-contain" />
      </div>
    );
  }

  if (kind === "pdf" && dataUrl) {
    return <iframe src={dataUrl} title={fileName} className="h-[32rem] w-full border-0" />;
  }

  if (kind === "html") {
    return (
      <iframe
        // Untrusted generated markup: no same-origin, no scripts, so a
        // deliverable can never reach the session it was produced in.
        sandbox=""
        srcDoc={content}
        title={fileName}
        className="h-96 w-full border-0 bg-white"
      />
    );
  }

  if (kind === "csv") return <CsvPreview content={content} />;

  return null;
}

/** First rows of a CSV/TSV, as a table. */
function CsvPreview({ content }: { content: string }) {
  const { header, rows, truncated } = React.useMemo(() => parseCsv(content, 50), [content]);
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
