import * as React from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
  ChevronsUpDown,
  ChevronsDownUp,
} from "lucide-react";
import { FileEntry, FileExplorerProps } from "./types";
import { shouldInterceptEscape, isImageFile, isMarkdownFile, getFileIcon, formatSize } from "./utils";
import { ImageViewer } from "./image-viewer";
import { FileViewer } from "./file-viewer";
import { MarkdownViewer } from "./markdown-viewer";

// ── Flat tree node ────────────────────────────────────────────────────────────

interface FlatNode {
  entry: FileEntry;
  depth: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function flattenTree(
  files: FileEntry[],
  expandedPaths: Set<string>,
  childrenCache: Map<string, FileEntry[]>,
  depth = 0,
): FlatNode[] {
  const result: FlatNode[] = [];
  for (const entry of files) {
    result.push({ entry, depth });
    if (entry.isDirectory && expandedPaths.has(entry.path)) {
      const children = childrenCache.get(entry.path) ?? [];
      result.push(...flattenTree(children, expandedPaths, childrenCache, depth + 1));
    }
  }
  return result;
}

/** Load children for a directory from the API. */
async function fetchChildren(runnerId: string, dirPath: string): Promise<FileEntry[]> {
  const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ path: dirPath }),
  });
  if (!res.ok) return [];
  const data = await res.json() as { ok: boolean; files: FileEntry[] };
  return data.files ?? [];
}

/** localStorage helpers for expanded path sets. */
function loadExpandedPaths(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveExpandedPaths(storageKey: string, paths: Set<string>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...paths]));
  } catch {
    // ignore quota/security errors
  }
}

// ── File Tree Row ─────────────────────────────────────────────────────────────

const ROW_HEIGHT = 30; // px — must match the rendered row height

interface FileTreeRowProps {
  node: FlatNode;
  isExpanded: boolean;
  isLoading: boolean;
  onToggle: (entry: FileEntry) => void;
}

const FileTreeRow = React.memo(function FileTreeRow({ node, isExpanded, isLoading, onToggle }: FileTreeRowProps) {
  const { entry, depth } = node;

  const icon = entry.isDirectory
    ? isExpanded
      ? <FolderOpen className="size-4 text-amber-500 dark:text-amber-400 flex-shrink-0" />
      : <Folder className="size-4 text-amber-500/70 dark:text-amber-400/70 flex-shrink-0" />
    : <File className="size-4 text-muted-foreground flex-shrink-0" />;

  const chevron = entry.isDirectory
    ? isExpanded
      ? <ChevronDown className="size-3 text-muted-foreground flex-shrink-0" />
      : <ChevronRight className="size-3 text-muted-foreground flex-shrink-0" />
    : <span className="size-3 flex-shrink-0" />;

  const emoji = !entry.isDirectory ? getFileIcon(entry.name) : null;

  return (
    <button
      type="button"
      onClick={() => onToggle(entry)}
      aria-expanded={entry.isDirectory ? isExpanded : undefined}
      aria-label={entry.isDirectory ? `Folder ${entry.name}` : `File ${entry.name}`}
      className={cn(
        "flex items-center gap-1 w-full text-left px-2 text-sm hover:bg-accent/60 transition-colors rounded-sm group",
        !entry.isDirectory && "cursor-pointer",
      )}
      style={{ paddingLeft: `${depth * 16 + 8}px`, height: `${ROW_HEIGHT}px` }}
    >
      {chevron}
      {icon}
      <span className="truncate flex-1" title={entry.name}>
        {emoji ? <span className="mr-1 text-xs">{emoji}</span> : null}
        {entry.name}
        {entry.isSymlink && <span className="text-xs text-muted-foreground ml-1">→</span>}
      </span>
      {!entry.isDirectory && entry.size !== undefined && (
        <span className="text-[0.6rem] text-muted-foreground/60 tabular-nums flex-shrink-0">{formatSize(entry.size)}</span>
      )}
      {isLoading && <Spinner className="size-3 flex-shrink-0" />}
    </button>
  );
});

// ── Main File Explorer Component ──────────────────────────────────────────────

export function FileExplorer({ runnerId, cwd, className, onClose, position = "left", onPositionChange, onDragStart }: FileExplorerProps) {
  const storageKey = `file-explorer:${runnerId}:${cwd}`;

  const [files, setFiles] = React.useState<FileEntry[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [viewingFile, setViewingFile] = React.useState<string | null>(null);

  // Lifted tree state
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(() => loadExpandedPaths(storageKey));
  const [childrenCache, setChildrenCache] = React.useState<Map<string, FileEntry[]>>(new Map());
  const [loadingPaths, setLoadingPaths] = React.useState<Set<string>>(new Set());
  const [expandingAll, setExpandingAll] = React.useState(false);

  // Persist expanded state whenever it changes
  React.useEffect(() => {
    saveExpandedPaths(storageKey, expandedPaths);
  }, [storageKey, expandedPaths]);

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

  // Toggle expand/collapse for a directory, or open a file
  const handleToggle = React.useCallback(async (entry: FileEntry) => {
    if (!entry.isDirectory) {
      setViewingFile(entry.path);
      return;
    }

    if (expandedPaths.has(entry.path)) {
      // Collapse
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.delete(entry.path);
        return next;
      });
      return;
    }

    // Expand — fetch children if not cached
    if (!childrenCache.has(entry.path)) {
      setLoadingPaths((prev) => new Set([...prev, entry.path]));
      const children = await fetchChildren(runnerId, entry.path);
      setChildrenCache((prev) => new Map([...prev, [entry.path, children]]));
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(entry.path);
        return next;
      });
    }

    setExpandedPaths((prev) => new Set([...prev, entry.path]));
  }, [runnerId, expandedPaths, childrenCache]);

  // Collapse All
  const handleCollapseAll = React.useCallback(() => {
    setExpandedPaths(new Set());
  }, []);

  // Expand All (BFS up to depth 3, fetching missing children)
  const handleExpandAll = React.useCallback(async () => {
    if (!files) return;
    setExpandingAll(true);

    const newCache = new Map(childrenCache);
    const toExpand = new Set<string>();

    interface BFSItem { entries: FileEntry[]; depth: number }
    const queue: BFSItem[] = [{ entries: files, depth: 0 }];

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth >= 3) continue;

      for (const entry of item.entries) {
        if (!entry.isDirectory) continue;
        toExpand.add(entry.path);

        let children = newCache.get(entry.path);
        if (!children) {
          children = await fetchChildren(runnerId, entry.path);
          newCache.set(entry.path, children);
        }
        queue.push({ entries: children, depth: item.depth + 1 });
      }
    }

    setChildrenCache(newCache);
    setExpandedPaths((prev) => new Set([...prev, ...toExpand]));
    setExpandingAll(false);
  }, [runnerId, files, childrenCache]);

  // Flat list for virtualization
  const flatNodes = React.useMemo(() => {
    if (!files) return [];
    return flattenTree(files, expandedPaths, childrenCache);
  }, [files, expandedPaths, childrenCache]);

  // Virtualizer
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Intercept Escape when viewing a file
  const previewContainerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!viewingFile) return;
    previewContainerRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!shouldInterceptEscape(previewContainerRef.current)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setViewingFile(null);
    };
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

  const outerRef = React.useRef<HTMLDivElement>(null);

  // File viewer routing
  if (viewingFile) {
    const viewingFileName = viewingFile.split("/").pop() ?? viewingFile;
    const isImage = isImageFile(viewingFileName);
    const isMarkdown = isMarkdownFile(viewingFileName);

    return (
      <div ref={previewContainerRef} tabIndex={-1} className={cn("flex flex-col bg-background text-foreground outline-none", className)}>
        {isImage ? (
          <ImageViewer
            runnerId={runnerId}
            filePath={viewingFile}
            onClose={() => setViewingFile(null)}
          />
        ) : isMarkdown ? (
          <MarkdownViewer
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
      {/* Path breadcrumb + toolbar */}
      <div className="flex items-center border-b border-border/50 bg-muted/50">
        <div className="flex-1 px-3 py-1.5 text-[0.65rem] text-muted-foreground font-mono truncate" title={cwd}>
          {cwd}
        </div>
        <TooltipProvider>
          <div className="flex items-center gap-0.5 pr-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void handleExpandAll()}
                  disabled={expandingAll || loading}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded transition-colors disabled:opacity-40"
                  aria-label="Expand all folders"
                >
                  {expandingAll
                    ? <Spinner className="size-3.5" />
                    : <ChevronsUpDown className="size-3.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent>Expand all (up to 3 levels)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCollapseAll}
                  disabled={expandedPaths.size === 0}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded transition-colors disabled:opacity-40"
                  aria-label="Collapse all folders"
                >
                  <ChevronsDownUp className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Collapse all</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void fetchFiles()}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded transition-colors"
                  aria-label="Refresh file list"
                >
                  <RefreshCw className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>

      {/* Content */}
      <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Spinner className="size-5" />
          </div>
        ) : error ? (
          <div className="p-4">
            <p className="text-sm text-red-400 mb-3">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void fetchFiles()}>
              <RefreshCw className="size-3 mr-1.5" /> Retry
            </Button>
          </div>
        ) : files && files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
            <Folder className="size-8 opacity-30" />
            <p className="text-sm">Empty directory</p>
          </div>
        ) : (
          <div
            style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
            className="py-1"
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const node = flatNodes[virtualItem.index];
              if (!node) return null;
              return (
                <div
                  key={virtualItem.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <FileTreeRow
                    node={node}
                    isExpanded={expandedPaths.has(node.entry.path)}
                    isLoading={loadingPaths.has(node.entry.path)}
                    onToggle={handleToggle}
                  />
                </div>
              );
            })}
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
export { MarkdownViewer } from "./markdown-viewer";
export {
  shouldInterceptEscape,
  formatSize,
  getFileIcon,
  isImageFile,
  isMarkdownFile,
  getMimeType,
  gitStatusLabel,
  IMAGE_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  POSITION_OPTIONS,
} from "./utils";
