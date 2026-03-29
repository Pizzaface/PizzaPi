import * as React from "react";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ChevronLeft,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Maximize2,
} from "lucide-react";
import { getMimeType, getFileIcon, formatSize } from "./utils";

// ── Image Viewer ──────────────────────────────────────────────────────────────

export function ImageViewer({
  runnerId,
  filePath,
  onClose,
}: {
  runnerId: string;
  filePath: string;
  onClose: () => void;
}) {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [fileSize, setFileSize] = React.useState<number | undefined>();
  const [zoom, setZoom] = React.useState(1);
  const [naturalSize, setNaturalSize] = React.useState<{ w: number; h: number } | null>(null);
  const [fitMode, setFitMode] = React.useState<"contain" | "actual">("contain");
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDataUrl(null);
    setZoom(1);
    setFitMode("contain");
    setNaturalSize(null);

    const fileName = filePath.split("/").pop() ?? filePath;
    const mime = getMimeType(fileName);

    void fetch(`/api/runners/${encodeURIComponent(runnerId)}/read-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ path: filePath, encoding: "base64" }),
    })
      .then((res) =>
        res.ok
          ? res.json()
          : res.json().then((d) => Promise.reject(new Error(d.error || `HTTP ${res.status}`)))
      )
      .then((data: any) => {
        if (cancelled) return;
        const b64 = data.content ?? "";
        setDataUrl(`data:${mime};base64,${b64}`);
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

    return () => {
      cancelled = true;
    };
  }, [runnerId, filePath]);

  const handleImageLoad = React.useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  const zoomIn = React.useCallback(() => setZoom((z) => Math.min(z * 1.5, 10)), []);
  const zoomOut = React.useCallback(() => setZoom((z) => Math.max(z / 1.5, 0.1)), []);
  const resetZoom = React.useCallback(() => {
    setZoom(1);
    setFitMode("contain");
  }, []);
  const toggleFit = React.useCallback(() => {
    setFitMode((m) => (m === "contain" ? "actual" : "contain"));
    setZoom(1);
  }, []);

  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
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
        <span className="text-sm font-mono truncate flex-1" title={filePath}>
          {fileName}
        </span>
        {naturalSize && (
          <span className="text-[0.6rem] text-muted-foreground tabular-nums flex-shrink-0">
            {naturalSize.w}×{naturalSize.h}
          </span>
        )}
        {fileSize !== undefined && (
          <span className="text-[0.6rem] text-muted-foreground tabular-nums flex-shrink-0">
            {formatSize(fileSize)}
          </span>
        )}
      </div>

      {/* Toolbar */}
      {dataUrl && (
        <TooltipProvider>
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border/50 bg-muted/30">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={zoomOut}
                  className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                  aria-label="Zoom out"
                >
                  <ZoomOut className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Zoom out</TooltipContent>
            </Tooltip>
            <span className="text-[0.65rem] text-muted-foreground tabular-nums w-12 text-center">
              {Math.round(zoom * 100)}%
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={zoomIn}
                  className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                  aria-label="Zoom in"
                >
                  <ZoomIn className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Zoom in</TooltipContent>
            </Tooltip>
            <div className="w-px h-4 bg-border mx-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={toggleFit}
                  className={cn(
                    "p-1 rounded transition-colors",
                    fitMode === "actual"
                      ? "text-foreground bg-accent"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent",
                  )}
                  aria-label={fitMode === "contain" ? "Show actual size" : "Fit to view"}
                >
                  <Maximize2 className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{fitMode === "contain" ? "Show actual size" : "Fit to view"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={resetZoom}
                  className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                  aria-label="Reset zoom"
                >
                  <RotateCw className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Reset zoom</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      )}

      {/* Image content */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto"
      >
        {loading && (
          <div className="flex items-center justify-center p-8">
            <Spinner className="size-5" />
          </div>
        )}
        {error && <div className="p-4 text-sm text-red-400">{error}</div>}
        {dataUrl && (
          <div
            className={cn(
              "min-h-full",
              fitMode === "contain"
                ? "flex items-center justify-center p-4"
                : "p-4",
            )}
          >
            {/* Checkerboard background for transparency */}
            <div
              className="inline-block rounded-md shadow-lg"
              style={{
                backgroundImage:
                  "repeating-conic-gradient(var(--checker-dark, #27272a) 0% 25%, var(--checker-light, #1c1c1e) 0% 50%)",
                backgroundSize: "16px 16px",
              }}
            >
              <img
                src={dataUrl}
                alt={fileName}
                onLoad={handleImageLoad}
                className="block rounded-md"
                draggable={false}
                style={
                  fitMode === "contain"
                    ? {
                        maxWidth: "100%",
                        maxHeight: "calc(100vh - 160px)",
                        transform: `scale(${zoom})`,
                        transformOrigin: "center center",
                        transition: "transform 0.15s ease",
                      }
                    : {
                        transform: `scale(${zoom})`,
                        transformOrigin: "top left",
                        transition: "transform 0.15s ease",
                      }
                }
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
