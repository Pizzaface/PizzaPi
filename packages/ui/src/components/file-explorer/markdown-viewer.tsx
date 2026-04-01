import * as React from "react";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ChevronLeft, Code, Eye } from "lucide-react";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Streamdown, defaultRehypePlugins } from "streamdown";
import { getFileIcon, formatSize } from "./utils";

// ── Markdown Viewer ───────────────────────────────────────────────────────────

const streamdownPlugins = { cjk, code, math, mermaid };

// Use defaultRehypePlugins for XSS safety (same as AI message rendering).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const safeRehypePlugins = [...Object.values(defaultRehypePlugins)] as any;

export function MarkdownViewer({
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
  const [mode, setMode] = React.useState<"preview" | "raw">("preview");

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);

    void fetch(`/api/runners/${encodeURIComponent(runnerId)}/read-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ path: filePath }),
    })
      .then((res) =>
        res.ok
          ? res.json()
          : res.json().then((d: any) => Promise.reject(new Error(d.error || `HTTP ${res.status}`)))
      )
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

    return () => {
      cancelled = true;
    };
  }, [runnerId, filePath]);

  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div className="flex flex-col h-full overflow-hidden">
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
        {fileSize !== undefined && (
          <span className="text-[0.6rem] text-muted-foreground tabular-nums flex-shrink-0">
            {formatSize(fileSize)}
          </span>
        )}
      </div>

      {/* Toolbar */}
      <TooltipProvider>
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border/50 bg-muted/30">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setMode("preview")}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors",
                  mode === "preview"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}
                aria-pressed={mode === "preview"}
                aria-label="Preview"
              >
                <Eye className="size-3" />
                Preview
              </button>
            </TooltipTrigger>
            <TooltipContent>Rendered markdown preview</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setMode("raw")}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors",
                  mode === "raw"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}
                aria-pressed={mode === "raw"}
                aria-label="Raw"
              >
                <Code className="size-3" />
                Raw
              </button>
            </TooltipTrigger>
            <TooltipContent>View raw markdown source</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>

      {/* Content */}
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
            {mode === "preview" ? (
              <div className="p-4 prose prose-sm dark:prose-invert max-w-none">
                <Streamdown
                  className="size-full break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                  plugins={streamdownPlugins}
                  rehypePlugins={safeRehypePlugins}
                >
                  {content}
                </Streamdown>
              </div>
            ) : (
              <pre className="p-3 text-xs font-mono text-foreground/80 leading-relaxed whitespace-pre-wrap break-all">
                {content}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
