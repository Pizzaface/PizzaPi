import * as React from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { useAtMentionFiles, type Entry } from "@/hooks/useAtMentionFiles";
import { ChevronLeft, File, Folder } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Icons ─────────────────────────────────────────────────────────────────────

function FileIcon({ className }: { className?: string }) {
  return <File className={cn("size-4 text-zinc-400", className)} />;
}

function FolderIcon({ className }: { className?: string }) {
  return <Folder className={cn("size-4 text-amber-400/70", className)} />;
}

// ── File Icon Emoji Helper (from FileExplorer) ────────────────────────────────

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

// ── Props ─────────────────────────────────────────────────────────────────────

export interface AtMentionPopoverProps {
  /** Whether the popover is open */
  open: boolean;
  /** Runner ID for fetching files */
  runnerId: string;
  /** Current directory path (e.g., "" for root, "src/", "src/components/") */
  path: string;
  /** Filter query (the text after the last "/" or after "@" if no "/") */
  query: string;
  /** Called when a file is selected. Receives relative path from cwd. */
  onSelectFile: (relativePath: string) => void;
  /** Called when drilling into a directory. Receives the new directory path. */
  onDrillInto: (path: string) => void;
  /** Called when the popover should close */
  onClose: () => void;
  /** Called when navigating back. If not provided, internal back logic is used. */
  onBack?: () => void;
  /** Index of highlighted item for keyboard navigation (-1 for none) */
  highlightedIndex?: number;
  /** Callback when highlighted index changes */
  onHighlightedIndexChange?: (index: number) => void;
  /** Callback when highlighted entry changes (for Tab key handling) */
  onHighlightedEntryChange?: (entry: Entry | null) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AtMentionPopover({
  open,
  runnerId,
  path,
  query,
  onSelectFile,
  onDrillInto,
  onClose,
  onBack,
  highlightedIndex = 0,
  onHighlightedIndexChange,
  onHighlightedEntryChange,
}: AtMentionPopoverProps) {
  // Fetch files for the current path
  const { entries, loading, error } = useAtMentionFiles(runnerId, path || ".", open);

  // Filter and sort entries
  const filteredEntries = React.useMemo(() => {
    if (!entries) return [];

    // Filter out dot-files/folders
    let filtered = entries.filter((entry) => !entry.name.startsWith("."));

    // Filter by query (case-insensitive)
    if (query) {
      const lowerQuery = query.toLowerCase();
      filtered = filtered.filter((entry) =>
        entry.name.toLowerCase().includes(lowerQuery)
      );
    }

    // Sort: directories first (alphabetical), then files (alphabetical)
    return filtered.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [entries, query]);

  // Handle item selection
  const handleSelect = React.useCallback(
    (entry: Entry) => {
      if (entry.isDirectory) {
        // Drill into directory
        const newPath = path ? `${path}${entry.name}/` : `${entry.name}/`;
        onDrillInto(newPath);
      } else {
        // Select file - return relative path from cwd
        const relativePath = path ? `${path}${entry.name}` : entry.name;
        onSelectFile(relativePath);
      }
    },
    [path, onDrillInto, onSelectFile]
  );

  // Handle back navigation
  const handleBack = React.useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    if (!path) return;
    // Remove trailing slash, then find last slash to get parent
    const withoutTrailing = path.replace(/\/$/, "");
    const lastSlashIndex = withoutTrailing.lastIndexOf("/");
    if (lastSlashIndex === -1) {
      // Going back to root
      onDrillInto("");
    } else {
      onDrillInto(withoutTrailing.slice(0, lastSlashIndex + 1));
    }
  }, [path, onDrillInto, onBack]);

  // Track the currently highlighted value for Tab handling
  const [highlightedValue, setHighlightedValue] = React.useState<string>("");

  // Reset highlighted index when entries change
  React.useEffect(() => {
    if (filteredEntries.length > 0) {
      const firstEntry = filteredEntries[0] ?? null;
      setHighlightedValue(firstEntry?.name ?? "");
      onHighlightedIndexChange?.(0);
      onHighlightedEntryChange?.(firstEntry);
    } else {
      setHighlightedValue("");
      onHighlightedIndexChange?.(-1);
      onHighlightedEntryChange?.(null);
    }
  }, [filteredEntries, onHighlightedIndexChange, onHighlightedEntryChange]);

  // Keyboard navigation
  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "Backspace" && !query && path) {
        // Go back when backspace is pressed with no query
        e.preventDefault();
        handleBack();
      } else if (e.key === "Tab" && filteredEntries.length > 0) {
        // Tab drills into highlighted folder
        const entry = filteredEntries.find(e => e.name === highlightedValue) ?? filteredEntries[0];
        if (entry?.isDirectory) {
          e.preventDefault();
          e.stopPropagation();
          const newPath = path ? `${path}${entry.name}/` : `${entry.name}/`;
          onDrillInto(newPath);
        }
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // Track highlighted item for Tab functionality
        const currentIndex = filteredEntries.findIndex(e => e.name === highlightedValue);
        let newIndex: number;
        if (e.key === "ArrowDown") {
          newIndex = currentIndex < filteredEntries.length - 1 ? currentIndex + 1 : 0;
        } else {
          newIndex = currentIndex > 0 ? currentIndex - 1 : filteredEntries.length - 1;
        }
        const newEntry = filteredEntries[newIndex];
        if (newEntry) {
          setHighlightedValue(newEntry.name);
          onHighlightedIndexChange?.(newIndex);
          onHighlightedEntryChange?.(newEntry);
        }
      }
    },
    [onClose, query, path, handleBack, filteredEntries, highlightedValue, onDrillInto, onHighlightedIndexChange, onHighlightedEntryChange]
  );

  if (!open) return null;

  const isAtRoot = !path;

  return (
    <div
      className="rounded-md border border-border bg-popover text-popover-foreground shadow-sm"
      onKeyDown={handleKeyDown}
    >
      <Command className="w-full" shouldFilter={false}>
        {/* Breadcrumb header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 text-xs">
          {!isAtRoot && (
            <button
              type="button"
              onClick={handleBack}
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronLeft className="size-3" />
              <span>Back</span>
            </button>
          )}
          <span className="font-mono text-muted-foreground truncate flex-1">
            {isAtRoot ? "/" : `/${path}`}
          </span>
          {query && (
            <span className="text-muted-foreground/60">
              filter: "{query}"
            </span>
          )}
        </div>

        <CommandList className="max-h-48">
          {/* Loading state */}
          {loading && (
            <div className="flex items-center justify-center py-4 gap-2">
              <Spinner className="size-4" />
              <span className="text-sm text-muted-foreground">Loading files…</span>
            </div>
          )}

          {/* Error state */}
          {error && !loading && (
            <div className="py-4 px-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && filteredEntries.length === 0 && (
            <CommandEmpty>
              {query ? `No files matching "${query}"` : "Empty directory"}
            </CommandEmpty>
          )}

          {/* File/folder list */}
          {!loading && !error && filteredEntries.length > 0 && (
            <CommandGroup>
              {filteredEntries.map((entry) => {
                const emoji = !entry.isDirectory ? getFileIcon(entry.name) : null;
                return (
                  <CommandItem
                    key={entry.path}
                    value={entry.name}
                    onSelect={() => handleSelect(entry)}
                    className="cursor-pointer"
                  >
                    {entry.isDirectory ? (
                      <FolderIcon />
                    ) : (
                      <FileIcon />
                    )}
                    <span className="truncate flex-1">
                      {emoji && <span className="mr-1 text-xs">{emoji}</span>}
                      {entry.name}
                    </span>
                    {entry.isDirectory && (
                      <span className="text-xs text-muted-foreground">→</span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </div>
  );
}
