import * as React from "react";
import { Spinner } from "@/components/ui/spinner";
import { ChevronLeft } from "lucide-react";
import { getFileIcon, formatSize } from "./utils";

// ── File Viewer ───────────────────────────────────────────────────────────────

export function FileViewer({
  runnerId,
  filePath,
  onClose,
}: {
  runnerId: string;
  filePath: string;
  onClose: () => void;
}) {
  const [content, setContent] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [truncated, setTruncated] = React.useState(false);
  const [fileSize, setFileSize] = React.useState<number | undefined>();

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void fetch(`/api/runners/${encodeURIComponent(runnerId)}/read-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ path: filePath }),
    })
      .then((res) => res.ok ? res.json() : res.json().then((d) => Promise.reject(new Error(d.error || `HTTP ${res.status}`))))
      .then((data: any) => {
        if (cancelled) return;
        setContent(data.content ?? "");
        setTruncated(data.truncated === true);
        setFileSize(typeof data.size === "number" ? data.size : undefined);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [runnerId, filePath]);

  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/50 min-h-[40px]">
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Back to file list"
          aria-label="Back to file list"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-xs text-muted-foreground mr-1">{getFileIcon(fileName)}</span>
        <span className="text-sm font-mono truncate flex-1" title={filePath}>{fileName}</span>
        {fileSize !== undefined && (
          <span className="text-[0.6rem] text-muted-foreground tabular-nums">{formatSize(fileSize)}</span>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center p-8">
            <Spinner className="size-5" />
          </div>
        )}
        {error && (
          <div className="p-4 text-sm text-red-400">{error}</div>
        )}
        {content !== null && (
          <div className="relative">
            {truncated && (
              <div className="sticky top-0 z-10 bg-amber-500/10 border-b border-amber-500/20 px-3 py-1 text-xs text-amber-600 dark:text-amber-400">
                File truncated (showing first 512 KB of {formatSize(fileSize)})
              </div>
            )}
            <pre className="p-3 text-xs font-mono text-foreground/80 leading-relaxed whitespace-pre-wrap break-all">
              {content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
