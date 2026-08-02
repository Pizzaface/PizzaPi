import * as React from "react";
import { ChevronLeft } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { formatSize, getFileIcon, getVideoMimeType } from "./utils";

export function VideoViewer({
  runnerId,
  filePath,
  onClose,
}: {
  runnerId: string;
  filePath: string;
  onClose: () => void;
}) {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null);
  const [fileSize, setFileSize] = React.useState<number>();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setDataUrl(null);
    setFileSize(undefined);
    setLoading(true);
    setError(null);

    void fetch(`/api/runners/${encodeURIComponent(runnerId)}/read-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      signal: controller.signal,
      body: JSON.stringify({ path: filePath, encoding: "base64", rejectTruncated: true }),
    })
      .then((res) => res.ok
        ? res.json()
        : res.json().then((data) => Promise.reject(new Error(data.error || `HTTP ${res.status}`))))
      .then((data: { content?: string; size?: number; truncated?: boolean }) => {
        if (cancelled) return;
        setFileSize(data.size);
        if (data.truncated) {
          setError(`Video is too large to preview (${formatSize(data.size)}; 10 MB max).`);
          return;
        }
        setDataUrl(`data:${getVideoMimeType(fileName)};base64,${data.content ?? ""}`);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runnerId, filePath, fileName]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex min-h-[40px] items-center gap-2 border-b border-border bg-muted/50 px-3 py-2">
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground transition-colors hover:text-foreground"
          title="Back to file list"
          aria-label="Back to file list"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="mr-1 text-xs text-muted-foreground">{getFileIcon(fileName)}</span>
        <span className="flex-1 truncate font-mono text-sm" title={filePath}>{fileName}</span>
        {fileSize !== undefined && (
          <span className="flex-shrink-0 text-[0.6rem] tabular-nums text-muted-foreground">
            {formatSize(fileSize)}
          </span>
        )}
      </div>

      <div className="flex flex-1 items-center justify-center overflow-auto bg-black p-4">
        {loading && (
          <div role="status" className="text-muted-foreground">
            <Spinner aria-hidden="true" className="size-5" />
            <span className="sr-only">Loading video preview</span>
          </div>
        )}
        {error && <div role="alert" className="text-sm text-red-400">{error}</div>}
        {dataUrl && !error && (
          <video
            src={dataUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={`Preview of ${fileName}`}
            className="max-h-full max-w-full"
            onError={() => setError("This browser cannot play the video.")}
          />
        )}
      </div>
    </div>
  );
}
