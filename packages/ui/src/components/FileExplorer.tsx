import * as React from "react";
import * as ReactDOM from "react-dom";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommit,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  ChevronLeft,
  FolderTree,
  Plus,
  Minus,
  Edit3,
  HelpCircle,
  FileQuestion,
  X,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Maximize2,
  Image as ImageIcon,
  GripHorizontal,
  PanelLeft,
  PanelRight,
  PanelBottom,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink?: boolean;
  size?: number;
}

interface GitChange {
  status: string;
  path: string;
  originalPath?: string;
}

interface GitStatus {
  branch: string;
  changes: GitChange[];
  ahead: number;
  behind: number;
  diffStaged?: string;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface FileExplorerProps {
  runnerId: string;
  cwd: string;
  className?: string;
  onClose?: () => void;
  /** Current docked position of the panel (desktop only). */
  position?: "left" | "right" | "bottom";
  /** Called when the user picks a new position via the header buttons. */
  onPositionChange?: (pos: "left" | "right" | "bottom") => void;
  /** Called when the user starts dragging the panel grip to reposition it. */
  onDragStart?: (e: React.PointerEvent) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const icons: Record<string, string> = {
    ts: "🟦", tsx: "⚛️", js: "🟨", jsx: "⚛️", json: "📋", md: "📝",
    css: "🎨", html: "🌐", py: "🐍", rs: "🦀", go: "🐹",
    sh: "🐚", bash: "🐚", zsh: "🐚", yml: "⚙️", yaml: "⚙️",
    toml: "⚙️", lock: "🔒", svg: "🖼️", png: "🖼️", jpg: "🖼️",
    gif: "🖼️", webp: "🖼️", mp4: "🎬", mp3: "🎵", pdf: "📄",
    zip: "📦", tar: "📦", gz: "📦", env: "🔐", gitignore: "🚫",
  };
  return icons[ext] ?? "";
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

function isImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

function getMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    avif: "image/avif",
  };
  return mimeMap[ext] ?? "image/png";
}

function gitStatusLabel(status: string): { label: string; color: string; icon: React.ReactNode } {
  switch (status) {
    case "M":
      return { label: "Modified", color: "text-amber-400", icon: <Edit3 className="size-3" /> };
    case "A":
      return { label: "Added", color: "text-green-400", icon: <Plus className="size-3" /> };
    case "D":
      return { label: "Deleted", color: "text-red-400", icon: <Minus className="size-3" /> };
    case "R":
      return { label: "Renamed", color: "text-blue-400", icon: <Edit3 className="size-3" /> };
    case "C":
      return { label: "Copied", color: "text-blue-400", icon: <Plus className="size-3" /> };
    case "??":
      return { label: "Untracked", color: "text-zinc-400", icon: <FileQuestion className="size-3" /> };
    case "!!":
      return { label: "Ignored", color: "text-zinc-600", icon: <HelpCircle className="size-3" /> };
    case "MM":
      return { label: "Modified (staged+unstaged)", color: "text-amber-400", icon: <Edit3 className="size-3" /> };
    case "AM":
      return { label: "Added + Modified", color: "text-green-400", icon: <Plus className="size-3" /> };
    default:
      return { label: status, color: "text-zinc-400", icon: <File className="size-3" /> };
  }
}

// ── File Tree Node ────────────────────────────────────────────────────────────

function FileTreeNode({
  entry,
  depth,
  runnerId,
  onSelectFile,
}: {
  entry: FileEntry;
  depth: number;
  runnerId: string;
  onSelectFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [children, setChildren] = React.useState<FileEntry[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  const toggle = React.useCallback(async () => {
    if (!entry.isDirectory) {
      onSelectFile(entry.path);
      return;
    }

    if (expanded) {
      setExpanded(false);
      return;
    }

    if (children === null) {
      setLoading(true);
      try {
        const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ path: entry.path }),
        });
        if (res.ok) {
          const data = await res.json() as { ok: boolean; files: FileEntry[] };
          setChildren(data.files ?? []);
        } else {
          setChildren([]);
        }
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }

    setExpanded(true);
  }, [entry, expanded, children, runnerId, onSelectFile]);

  const icon = entry.isDirectory
    ? expanded
      ? <FolderOpen className="size-4 text-amber-400" />
      : <Folder className="size-4 text-amber-400/70" />
    : <File className="size-4 text-zinc-400" />;

  const chevron = entry.isDirectory
    ? expanded
      ? <ChevronDown className="size-3 text-zinc-500" />
      : <ChevronRight className="size-3 text-zinc-500" />
    : <span className="size-3" />;

  const emoji = !entry.isDirectory ? getFileIcon(entry.name) : null;

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={entry.isDirectory ? expanded : undefined}
        aria-label={entry.isDirectory ? `Folder ${entry.name}` : `File ${entry.name}`}
        className={cn(
          "flex items-center gap-1 w-full text-left px-2 py-1 text-sm hover:bg-zinc-800/60 transition-colors rounded-sm group",
          !entry.isDirectory && "cursor-pointer",
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {chevron}
        {icon}
        <span className="truncate flex-1" title={entry.name}>
          {emoji ? <span className="mr-1 text-xs">{emoji}</span> : null}
          {entry.name}
          {entry.isSymlink && <span className="text-xs text-zinc-500 ml-1">→</span>}
        </span>
        {!entry.isDirectory && entry.size !== undefined && (
          <span className="text-[0.6rem] text-zinc-600 tabular-nums flex-shrink-0">{formatSize(entry.size)}</span>
        )}
        {loading && <Spinner className="size-3 flex-shrink-0" />}
      </button>
      {expanded && children && children.map((child) => (
        <FileTreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          runnerId={runnerId}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}

// ── Image Viewer ──────────────────────────────────────────────────────────────

function ImageViewer({
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
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/50 min-h-[40px]">
        <button
          type="button"
          onClick={onClose}
          className="text-zinc-400 hover:text-zinc-100 transition-colors"
          title="Back to file list"
          aria-label="Back to file list"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-xs text-zinc-500 mr-1">{getFileIcon(fileName)}</span>
        <span className="text-sm font-mono truncate flex-1" title={filePath}>
          {fileName}
        </span>
        {naturalSize && (
          <span className="text-[0.6rem] text-zinc-500 tabular-nums flex-shrink-0">
            {naturalSize.w}×{naturalSize.h}
          </span>
        )}
        {fileSize !== undefined && (
          <span className="text-[0.6rem] text-zinc-500 tabular-nums flex-shrink-0">
            {formatSize(fileSize)}
          </span>
        )}
      </div>

      {/* Toolbar */}
      {dataUrl && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-zinc-800/50 bg-zinc-900/30">
          <button
            type="button"
            onClick={zoomOut}
            className="p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded transition-colors"
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ZoomOut className="size-3.5" />
          </button>
          <span className="text-[0.65rem] text-zinc-500 tabular-nums w-12 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={zoomIn}
            className="p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded transition-colors"
            title="Zoom in"
            aria-label="Zoom in"
          >
            <ZoomIn className="size-3.5" />
          </button>
          <div className="w-px h-4 bg-zinc-700 mx-1" />
          <button
            type="button"
            onClick={toggleFit}
            className={cn(
              "p-1 rounded transition-colors",
              fitMode === "actual"
                ? "text-zinc-100 bg-zinc-800"
                : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800",
            )}
            title={fitMode === "contain" ? "Show actual size" : "Fit to view"}
            aria-label={fitMode === "contain" ? "Show actual size" : "Fit to view"}
          >
            <Maximize2 className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={resetZoom}
            className="p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded transition-colors"
            title="Reset zoom"
            aria-label="Reset zoom"
          >
            <RotateCw className="size-3.5" />
          </button>
        </div>
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
                  "repeating-conic-gradient(#27272a 0% 25%, #1c1c1e 0% 50%)",
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

// ── File Viewer ───────────────────────────────────────────────────────────────

function FileViewer({
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
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/50 min-h-[40px]">
        <button
          type="button"
          onClick={onClose}
          className="text-zinc-400 hover:text-zinc-100 transition-colors"
          title="Back to file list"
          aria-label="Back to file list"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-xs text-zinc-500 mr-1">{getFileIcon(fileName)}</span>
        <span className="text-sm font-mono truncate flex-1" title={filePath}>{fileName}</span>
        {fileSize !== undefined && (
          <span className="text-[0.6rem] text-zinc-500 tabular-nums">{formatSize(fileSize)}</span>
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
              <div className="sticky top-0 z-10 bg-amber-500/10 border-b border-amber-500/20 px-3 py-1 text-xs text-amber-400">
                File truncated (showing first 512 KB of {formatSize(fileSize)})
              </div>
            )}
            <pre className="p-3 text-xs font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap break-all">
              {content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Git Changes View ──────────────────────────────────────────────────────────

function GitChangesView({
  runnerId,
  cwd,
}: {
  runnerId: string;
  cwd: string;
}) {
  const [gitStatus, setGitStatus] = React.useState<GitStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedDiff, setSelectedDiff] = React.useState<{ path: string; diff: string } | null>(null);
  const [diffLoading, setDiffLoading] = React.useState(false);

  const fetchStatus = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/git-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cwd }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as any;
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as any;
      setGitStatus({
        branch: data.branch ?? "",
        changes: Array.isArray(data.changes) ? data.changes : [],
        ahead: data.ahead ?? 0,
        behind: data.behind ?? 0,
        diffStaged: data.diffStaged ?? "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [runnerId, cwd]);

  React.useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const viewDiff = React.useCallback(async (filePath: string) => {
    setDiffLoading(true);
    try {
      const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/git-diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cwd, path: filePath }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as any;
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as any;
      setSelectedDiff({ path: filePath, diff: data.diff ?? "(no diff)" });
    } catch {
      setSelectedDiff({ path: filePath, diff: "(failed to load diff)" });
    } finally {
      setDiffLoading(false);
    }
  }, [runnerId, cwd]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner className="size-5" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <p className="text-sm text-red-400 mb-3">{error}</p>
        <Button variant="outline" size="sm" onClick={fetchStatus}>
          <RefreshCw className="size-3 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  if (!gitStatus) return null;

  if (selectedDiff) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/50">
          <button
            type="button"
            onClick={() => setSelectedDiff(null)}
            className="text-zinc-400 hover:text-zinc-100 transition-colors"
            title="Back to changes"
            aria-label="Back to changes"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="text-sm font-mono truncate flex-1">{selectedDiff.path}</span>
        </div>
        <div className="flex-1 overflow-auto">
          <pre className="p-3 text-xs font-mono leading-relaxed whitespace-pre-wrap break-all">
            {selectedDiff.diff.split("\n").map((line, i) => {
              let color = "text-zinc-400";
              if (line.startsWith("+") && !line.startsWith("+++")) color = "text-green-400";
              else if (line.startsWith("-") && !line.startsWith("---")) color = "text-red-400";
              else if (line.startsWith("@@")) color = "text-blue-400";
              else if (line.startsWith("diff ") || line.startsWith("index ")) color = "text-zinc-500";
              return (
                <div key={i} className={cn(color, "min-h-[1.25em]")}>
                  {line || "\u00A0"}
                </div>
              );
            })}
          </pre>
        </div>
      </div>
    );
  }

  const staged = gitStatus.changes.filter((c) => c.status.length === 2 && c.status[0] !== "?" && c.status[0] !== " " && c.status[0] !== "!");
  const unstaged = gitStatus.changes.filter((c) => c.status === "??" || (c.status.length === 2 && c.status[1] !== " "));
  const hasChanges = gitStatus.changes.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Branch header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/50">
        <GitBranch className="size-4 text-green-400" />
        <span className="text-sm font-medium text-zinc-200">{gitStatus.branch || "detached"}</span>
        <div className="flex-1" />
        {gitStatus.ahead > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[0.65rem] text-green-400" title={`${gitStatus.ahead} commit(s) ahead`}>
            <ArrowUp className="size-3" /> {gitStatus.ahead}
          </span>
        )}
        {gitStatus.behind > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[0.65rem] text-amber-400" title={`${gitStatus.behind} commit(s) behind`}>
            <ArrowDown className="size-3" /> {gitStatus.behind}
          </span>
        )}
        <button
          type="button"
          onClick={fetchStatus}
          className="text-zinc-500 hover:text-zinc-200 transition-colors"
          title="Refresh git status"
          aria-label="Refresh git status"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {!hasChanges ? (
          <div className="flex flex-col items-center justify-center py-8 text-zinc-500 gap-2">
            <GitCommit className="size-8 opacity-30" />
            <p className="text-sm">Working tree clean</p>
          </div>
        ) : (
          <div className="py-1">
            {/* Staged changes */}
            {staged.length > 0 && (
              <div className="mb-2">
                <div className="px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-zinc-500">
                  Staged Changes ({staged.length})
                </div>
                {staged.map((change) => {
                  const info = gitStatusLabel(change.status[0]);
                  return (
                    <button
                      key={`staged-${change.path}`}
                      type="button"
                      onClick={() => viewDiff(change.path)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-zinc-800/60 transition-colors text-left"
                    >
                      <span className={cn("flex-shrink-0", info.color)} title={info.label}>{info.icon}</span>
                      <span className="truncate flex-1 font-mono text-xs text-zinc-300">{change.path}</span>
                      <span className={cn("text-[0.6rem] flex-shrink-0", info.color)}>{change.status[0]}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Unstaged/untracked changes */}
            {unstaged.length > 0 && (
              <div>
                <div className="px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-zinc-500">
                  Changes ({unstaged.length})
                </div>
                {unstaged.map((change) => {
                  const displayStatus = change.status === "??" ? "??" : change.status.length === 2 ? change.status[1] : change.status;
                  const info = gitStatusLabel(displayStatus);
                  return (
                    <button
                      key={`unstaged-${change.path}`}
                      type="button"
                      onClick={() => viewDiff(change.path)}
                      disabled={change.status === "??"}
                      className={cn(
                        "flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-zinc-800/60 transition-colors text-left",
                        change.status === "??" && "cursor-default hover:bg-transparent",
                      )}
                    >
                      <span className={cn("flex-shrink-0", info.color)} title={info.label}>{info.icon}</span>
                      <span className="truncate flex-1 font-mono text-xs text-zinc-300">{change.path}</span>
                      <span className={cn("text-[0.6rem] flex-shrink-0", info.color)}>{displayStatus}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {diffLoading && (
        <div className="flex items-center justify-center py-4 border-t border-zinc-800">
          <Spinner className="size-4" />
          <span className="text-xs text-zinc-500 ml-2">Loading diff…</span>
        </div>
      )}
    </div>
  );
}

// ── Position Picker (click-and-hold dropdown) ────────────────────────────────

const POSITION_OPTIONS = [
  { pos: "left" as const, Icon: PanelLeft, label: "Left" },
  { pos: "bottom" as const, Icon: PanelBottom, label: "Bottom" },
  { pos: "right" as const, Icon: PanelRight, label: "Right" },
] as const;

const PositionDropdown = React.forwardRef<
  HTMLDivElement,
  {
    containerRef: React.RefObject<HTMLDivElement | null>;
    position: "left" | "right" | "bottom";
    onSelect: (pos: "left" | "right" | "bottom") => void;
  }
>(function PositionDropdown({ containerRef, position, onSelect }, ref) {
  const [coords, setCoords] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dropdownWidth = 3 * 28 + 2 * 2 + 8;
    setCoords({
      top: rect.top - 6 - 36,
      left: rect.left + rect.width / 2 - dropdownWidth / 2,
    });
  }, [containerRef]);

  if (!coords) return null;

  return (
    <div
      ref={ref}
      className="fixed flex items-center gap-0.5 rounded-lg bg-zinc-800 border border-zinc-700 p-1 shadow-xl z-[9999] animate-in fade-in zoom-in-95 duration-100"
      style={{ top: coords.top, left: coords.left }}
    >
      {POSITION_OPTIONS.map(({ pos, Icon, label }) => (
        <button
          key={pos}
          type="button"
          onClick={() => onSelect(pos)}
          className={cn(
            "flex items-center justify-center size-7 rounded transition-colors",
            position === pos
              ? "bg-zinc-600 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700",
          )}
          title={label}
          aria-label={`Move panel to ${label}`}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
});

function PositionPicker({
  position,
  onPositionChange,
}: {
  position: "left" | "right" | "bottom";
  onPositionChange: (pos: "left" | "right" | "bottom") => void;
}) {
  const [open, setOpen] = React.useState(false);
  const holdTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const wasHeld = React.useRef(false);

  const ActiveIcon = POSITION_OPTIONS.find((o) => o.pos === position)!.Icon;

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current && !containerRef.current.contains(target) &&
        (!dropdownRef.current || !dropdownRef.current.contains(target))
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handler, true);
    return () => document.removeEventListener("pointerdown", handler, true);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const clearHold = () => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  const handlePointerDown = () => {
    wasHeld.current = false;
    holdTimer.current = setTimeout(() => {
      wasHeld.current = true;
      setOpen(true);
    }, 300);
  };

  const handlePointerUp = () => {
    clearHold();
    if (!wasHeld.current) {
      setOpen((v) => !v);
    }
  };

  const handlePointerLeave = () => {
    clearHold();
  };

  const handleSelect = (pos: "left" | "right" | "bottom") => {
    onPositionChange(pos);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        className={cn(
          "flex items-center justify-center size-7 rounded transition-colors",
          open
            ? "bg-zinc-700 text-zinc-200"
            : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800",
        )}
        title="Panel position"
        aria-label="Panel position"
      >
        <ActiveIcon size={13} />
      </button>

      {open && ReactDOM.createPortal(
        <PositionDropdown
          ref={dropdownRef}
          containerRef={containerRef}
          position={position}
          onSelect={handleSelect}
        />,
        document.body,
      )}
    </div>
  );
}

// ── Main File Explorer Component ──────────────────────────────────────────────

export function FileExplorer({ runnerId, cwd, className, onClose, position = "left", onPositionChange, onDragStart }: FileExplorerProps) {
  const [tab, setTab] = React.useState<"files" | "git">("files");
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

  // If viewing a file, show the appropriate viewer
  if (viewingFile) {
    const viewingFileName = viewingFile.split("/").pop() ?? viewingFile;
    const isImage = isImageFile(viewingFileName);

    return (
      <div className={cn("flex flex-col bg-zinc-950 text-zinc-100", className)}>
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
    <div className={cn("flex flex-col bg-zinc-950 text-zinc-100", className)}>
      {/* Header with tabs */}
      <div className="flex items-center border-b border-zinc-800 bg-zinc-900/50">
        {/* Mobile back button */}
        {onClose && (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-sm text-zinc-400 hover:text-zinc-100 h-9 px-2 md:hidden"
            onClick={onClose}
          >
            <ChevronLeft className="size-4" />
            Back
          </Button>
        )}

        {/* Tab buttons */}
        <div className="flex items-center flex-1">
          <button
            type="button"
            onClick={() => setTab("files")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors border-b-2",
              tab === "files"
                ? "border-primary text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300",
            )}
          >
            <FolderTree className="size-3.5" />
            Files
          </button>
          <button
            type="button"
            onClick={() => setTab("git")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors border-b-2",
              tab === "git"
                ? "border-primary text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300",
            )}
          >
            <GitBranch className="size-3.5" />
            Git
          </button>
        </div>

        {/* Refresh button for files tab */}
        {tab === "files" && (
          <button
            type="button"
            onClick={fetchFiles}
            className="text-zinc-500 hover:text-zinc-200 transition-colors px-2 py-1"
            title="Refresh file list"
            aria-label="Refresh file list"
          >
            <RefreshCw className="size-3.5" />
          </button>
        )}

        {/* Desktop: grip + position buttons + close */}
        <div className="hidden md:flex items-center gap-px pr-1 shrink-0">
          {onDragStart && (
            <div
              className="flex items-center justify-center size-7 rounded cursor-grab active:cursor-grabbing text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-colors touch-none select-none"
              onPointerDown={onDragStart}
              title="Drag to reposition panel"
              aria-label="Drag to reposition panel"
            >
              <GripHorizontal size={13} />
            </div>
          )}
          {onPositionChange && (
            <>
              <div className="w-px h-4 bg-zinc-700 mx-1 shrink-0" />
              <PositionPicker position={position} onPositionChange={onPositionChange} />
              <div className="w-px h-4 bg-zinc-700 mx-1 shrink-0" />
            </>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="flex items-center justify-center size-7 rounded text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              title="Close file explorer"
              aria-label="Close file explorer"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* Mobile close (back button already handles this, but keep X for symmetry) */}
      </div>

      {/* Path breadcrumb */}
      <div className="px-3 py-1.5 text-[0.65rem] text-zinc-500 font-mono truncate border-b border-zinc-800/50" title={cwd}>
        {cwd}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === "files" ? (
          loading ? (
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
            <div className="flex flex-col items-center justify-center py-8 text-zinc-500 gap-2">
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
          )
        ) : (
          <GitChangesView runnerId={runnerId} cwd={cwd} />
        )}
      </div>
    </div>
  );
}
