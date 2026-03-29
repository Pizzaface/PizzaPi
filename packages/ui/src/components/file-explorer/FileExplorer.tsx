import * as React from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Folder,
  RefreshCw,
} from "lucide-react";
import { FileEntry, FileExplorerProps } from "./types";
import { shouldInterceptEscape, isImageFile } from "./utils";
import { FileTreeNode } from "./file-tree-node";
import { ImageViewer } from "./image-viewer";
import { FileViewer } from "./file-viewer";

// ── Main File Explorer Component ──────────────────────────────────────────────

export function FileExplorer({ runnerId, cwd, className, onClose, position = "left", onPositionChange, onDragStart }: FileExplorerProps) {
  const [files, setFiles] = React.useState<FileEntry[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [viewingFile, setViewingFile] = React.useState<string | null>(null);

  const fetchFiles = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ path: cwd }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as any;
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as { ok: boolean; files: FileEntry[] };
      setFiles(data.files ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [runnerId, cwd]);

  React.useEffect(() => {
    void fetchFiles();
  }, [fetchFiles]);

  // Intercept Escape when viewing a file so it closes the preview
  // instead of propagating to SessionViewer's abort handler.
  const previewContainerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!viewingFile) return;
    // Move focus into the preview container so Escape is intercepted even when
    // the preview was opened via mouse click (no keyboard focus in container yet).
    previewContainerRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!shouldInterceptEscape(previewContainerRef.current)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setViewingFile(null);
    };
    // Capture phase ensures this fires before SessionViewer's bubble-phase listener
    // Clicking on non-focusable content inside the preview (e.g. <pre>, <img>)
    // moves document.activeElement to body in Chrome, breaking shouldInterceptEscape.
    // Re-focus the container whenever a click inside it drops focus to body.
    const restoreFocusPreview = (e: PointerEvent) => {
      if (!previewContainerRef.current?.contains(e.target as Node)) return;
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) {
          previewContainerRef.current?.focus();
        }
      });
    };
    document.addEventListener("keydown", handler, true);
    document.addEventListener("pointerdown", restoreFocusPreview);
    return () => {
      document.removeEventListener("keydown", handler, true);
      document.removeEventListener("pointerdown", restoreFocusPreview);
    };
  }, [viewingFile]);

  // outerRef covers the full FileExplorer panel including tab strip, breadcrumb,
  // and desktop controls.  GitChangesView uses it so Escape still closes the diff
  // preview when focus is on those chrome elements rather than inside the diff body.
  const outerRef = React.useRef<HTMLDivElement>(null);

  // If viewing a file, show the appropriate viewer
  if (viewingFile) {
    const viewingFileName = viewingFile.split("/").pop() ?? viewingFile;
    const isImage = isImageFile(viewingFileName);

    return (
      <div ref={previewContainerRef} tabIndex={-1} className={cn("flex flex-col bg-background text-foreground outline-none", className)}>
        {isImage ? (
          <ImageViewer
            runnerId={runnerId}
            filePath={viewingFile}
            onClose={() => setViewingFile(null)}
          />
        ) : (
          <FileViewer
            runnerId={runnerId}
            filePath={viewingFile}
            onClose={() => setViewingFile(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div ref={outerRef} className={cn("flex flex-col bg-background text-foreground", className)}>
      {/* Path breadcrumb */}
      <div className="flex items-center border-b border-border/50 bg-muted/50">
        <div className="flex-1 px-3 py-1.5 text-[0.65rem] text-muted-foreground font-mono truncate" title={cwd}>
          {cwd}
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={fetchFiles}
                className="text-muted-foreground hover:text-foreground transition-colors px-2 py-1"
                aria-label="Refresh file list"
              >
                <RefreshCw className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Refresh file list</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Spinner className="size-5" />
          </div>
        ) : error ? (
          <div className="p-4">
            <p className="text-sm text-red-400 mb-3">{error}</p>
            <Button variant="outline" size="sm" onClick={fetchFiles}>
              <RefreshCw className="size-3 mr-1.5" /> Retry
            </Button>
          </div>
        ) : files && files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
            <Folder className="size-8 opacity-30" />
            <p className="text-sm">Empty directory</p>
          </div>
        ) : (
          <div className="py-1">
            {files?.map((entry) => (
              <FileTreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                runnerId={runnerId}
                onSelectFile={setViewingFile}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Barrel re-exports ─────────────────────────────────────────────────────────

export type { FileEntry, GitChange, GitStatus, FileExplorerProps } from "./types";
export { GitChangesView } from "./git-changes-view";
export { PositionPicker } from "./position-picker";
export { FileTreeNode } from "./file-tree-node";
export { ImageViewer } from "./image-viewer";
export { FileViewer } from "./file-viewer";
export {
  shouldInterceptEscape,
  formatSize,
  getFileIcon,
  isImageFile,
  getMimeType,
  gitStatusLabel,
  IMAGE_EXTENSIONS,
  POSITION_OPTIONS,
} from "./utils";
