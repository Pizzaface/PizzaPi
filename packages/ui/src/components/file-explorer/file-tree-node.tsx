import * as React from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
} from "lucide-react";
import { FileEntry } from "./types";
import { getFileIcon, formatSize } from "./utils";

// ── File Tree Node ────────────────────────────────────────────────────────────

export function FileTreeNode({
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
      ? <FolderOpen className="size-4 text-amber-500 dark:text-amber-400" />
      : <Folder className="size-4 text-amber-500/70 dark:text-amber-400/70" />
    : <File className="size-4 text-muted-foreground" />;

  const chevron = entry.isDirectory
    ? expanded
      ? <ChevronDown className="size-3 text-muted-foreground" />
      : <ChevronRight className="size-3 text-muted-foreground" />
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
          "flex items-center gap-1 w-full text-left px-2 py-1 text-sm hover:bg-accent/60 transition-colors rounded-sm group",
          !entry.isDirectory && "cursor-pointer",
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
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
