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
import { useAtMentionSearch } from "@/hooks/useAtMentionSearch";
import { Bot, ChevronLeft, File, Folder, Search, X } from "lucide-react";
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

// ── Agent type ────────────────────────────────────────────────────────────────

export interface AtMentionAgent {
  name: string;
  description?: string;
}

// ── Unified item type for keyboard navigation ────────────────────────────────

type PopoverItem =
  | { kind: "agent"; agent: AtMentionAgent; value: string }
  | { kind: "file"; entry: Entry & { relativePath?: string }; value: string };

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
  /** Absolute working directory of the session (used as base for file paths) */
  sessionCwd?: string;
  /** Index of highlighted item for keyboard navigation (-1 for none) */
  highlightedIndex?: number;
  /** Callback when highlighted index changes */
  onHighlightedIndexChange?: (index: number) => void;
  /** Callback when highlighted entry changes (for Tab key handling) */
  onHighlightedEntryChange?: (entry: Entry | null) => void;
  /** Available agents to show at root level */
  agents?: AtMentionAgent[];
  /** Called when an agent is selected. Receives the agent name. */
  onSelectAgent?: (agentName: string) => void;
  /** Callback when highlighted agent changes (null when a file is highlighted) */
  onHighlightedAgentChange?: (agentName: string | null) => void;
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
  sessionCwd,
  highlightedIndex = 0,
  onHighlightedIndexChange,
  onHighlightedEntryChange,
  agents,
  onSelectAgent,
  onHighlightedAgentChange,
}: AtMentionPopoverProps) {
  // Recursive search mode: query present but no directory path navigated to
  const isSearchMode = !!query && !path;

  // Fetch directory listing (used when browsing or when in a specific path)
  const { entries: dirEntries, loading: dirLoading, error: dirError } = useAtMentionFiles(
    runnerId, path, open && !isSearchMode, sessionCwd
  );

  // Recursive search (used when typing a query at root level)
  const { entries: searchEntries, loading: searchLoading, error: searchError } = useAtMentionSearch(
    runnerId, query, open && isSearchMode, sessionCwd
  );

  const entries = isSearchMode ? searchEntries : dirEntries;
  const loading = isSearchMode ? searchLoading : dirLoading;
  const error = isSearchMode ? searchError : dirError;

  // Agents are shown at root level when not browsing into a directory
  const showAgents = !path && !query?.includes("/") && Array.isArray(agents) && agents.length > 0;

  // Filter agents by query
  const filteredAgents = React.useMemo(() => {
    if (!showAgents || !agents) return [];
    if (!query) return agents;
    const lowerQuery = query.toLowerCase();
    return agents.filter((a) =>
      a.name.toLowerCase().includes(lowerQuery) ||
      (a.description ?? "").toLowerCase().includes(lowerQuery)
    );
  }, [agents, query, showAgents]);

  // Filter and sort file entries
  const filteredEntries = React.useMemo(() => {
    if (!entries) return [];

    // In search mode, entries are already filtered by the server
    if (isSearchMode) return entries;

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
  }, [entries, query, isSearchMode]);

  // Build a unified flat list for keyboard navigation (agents first, then files)
  const allItems = React.useMemo<PopoverItem[]>(() => {
    const items: PopoverItem[] = [];
    for (const agent of filteredAgents) {
      items.push({ kind: "agent", agent, value: `agent:${agent.name}` });
    }
    for (const entry of filteredEntries) {
      const searchEntry = entry as Entry & { relativePath?: string };
      const value = isSearchMode ? (searchEntry.relativePath ?? entry.name) : entry.name;
      items.push({ kind: "file", entry: searchEntry, value });
    }
    return items;
  }, [filteredAgents, filteredEntries, isSearchMode]);

  // Handle file item selection
  const handleSelectFile = React.useCallback(
    (entry: Entry & { relativePath?: string }) => {
      if (entry.isDirectory) {
        // Drill into directory
        const newPath = path ? `${path}${entry.name}/` : `${entry.name}/`;
        onDrillInto(newPath);
      } else {
        // Select file - use relativePath from search results, or construct from path
        const relPath = entry.relativePath ?? (path ? `${path}${entry.name}` : entry.name);
        onSelectFile(relPath);
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

  // Track the currently highlighted value for keyboard navigation
  const [highlightedValue, setHighlightedValue] = React.useState<string>("");

  // Reset highlighted index when items change
  React.useEffect(() => {
    if (allItems.length > 0) {
      const first = allItems[0];
      setHighlightedValue(first.value);
      onHighlightedIndexChange?.(0);
      onHighlightedEntryChange?.(first.kind === "file" ? first.entry : null);
      onHighlightedAgentChange?.(first.kind === "agent" ? first.agent.name : null);
    } else {
      setHighlightedValue("");
      onHighlightedIndexChange?.(-1);
      onHighlightedEntryChange?.(null);
      onHighlightedAgentChange?.(null);
    }
  }, [allItems, onHighlightedIndexChange, onHighlightedEntryChange, onHighlightedAgentChange]);

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
      } else if (e.key === "Tab" && allItems.length > 0) {
        // Tab drills into highlighted folder (only for file items)
        const item = allItems.find(i => i.value === highlightedValue) ?? allItems[0];
        if (item?.kind === "file" && item.entry.isDirectory) {
          e.preventDefault();
          e.stopPropagation();
          const newPath = path ? `${path}${item.entry.name}/` : `${item.entry.name}/`;
          onDrillInto(newPath);
        }
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const currentIndex = allItems.findIndex(i => i.value === highlightedValue);
        let newIndex: number;
        if (e.key === "ArrowDown") {
          newIndex = currentIndex < allItems.length - 1 ? currentIndex + 1 : 0;
        } else {
          newIndex = currentIndex > 0 ? currentIndex - 1 : allItems.length - 1;
        }
        const newItem = allItems[newIndex];
        if (newItem) {
          setHighlightedValue(newItem.value);
          onHighlightedIndexChange?.(newIndex);
          onHighlightedEntryChange?.(newItem.kind === "file" ? newItem.entry : null);
          onHighlightedAgentChange?.(newItem.kind === "agent" ? newItem.agent.name : null);
        }
      }
    },
    [onClose, query, path, handleBack, allItems, highlightedValue, onDrillInto, onHighlightedIndexChange, onHighlightedEntryChange]
  );

  if (!open) return null;

  const isAtRoot = !path;
  const hasAgents = filteredAgents.length > 0;
  const hasFiles = filteredEntries.length > 0;
  const hasAny = hasAgents || hasFiles;

  return (
    <div
      className="rounded-md border border-border bg-popover text-popover-foreground shadow-sm"
      onKeyDown={handleKeyDown}
      role="listbox"
      aria-label="Mentions"
    >
      <Command className="w-full" shouldFilter={false}>
        {/* Breadcrumb header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 text-xs">
          {!isAtRoot && !isSearchMode && (
            <button
              type="button"
              onClick={handleBack}
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronLeft className="size-3" />
              <span>Back</span>
            </button>
          )}
          {isSearchMode ? (
            <>
              <Search className="size-3 text-muted-foreground" />
              <span className="font-mono text-muted-foreground truncate flex-1">
                search: &ldquo;{query}&rdquo;
              </span>
            </>
          ) : (
            <>
              <span className="font-mono text-muted-foreground truncate flex-1">
                {isAtRoot
                  ? (sessionCwd ? sessionCwd.split("/").filter(Boolean).pop() ?? "/" : "/")
                  : `${sessionCwd ? sessionCwd.split("/").filter(Boolean).pop() + "/" : "/"}${path}`}
              </span>
              {query && (
                <span className="text-muted-foreground/60">
                  filter: &ldquo;{query}&rdquo;
                </span>
              )}
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors flex-shrink-0"
            aria-label="Close mention picker"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <CommandList className="max-h-[50vh] overflow-y-auto">
          {/* Loading state */}
          {loading && (
            <div className="flex items-center justify-center py-4 gap-2">
              <Spinner className="size-4" />
              <span className="text-sm text-muted-foreground">Loading…</span>
            </div>
          )}

          {/* Error state */}
          {error && !loading && (
            <div className="py-4 px-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && !hasAny && (
            <CommandEmpty>
              {query ? `No matches for "${query}"` : "Empty directory"}
            </CommandEmpty>
          )}

          {/* Agent items */}
          {!loading && !error && hasAgents && (
            <CommandGroup heading="Agents">
              {filteredAgents.map((agent) => {
                const itemValue = `agent:${agent.name}`;
                return (
                  <CommandItem
                    key={itemValue}
                    value={itemValue}
                    onSelect={() => onSelectAgent?.(agent.name)}
                    className="cursor-pointer"
                    role="option"
                    aria-selected={highlightedValue === itemValue}
                  >
                    <Bot className="size-4 text-primary/60" />
                    <span className="font-mono truncate flex-1">{agent.name}</span>
                    {agent.description && (
                      <span className="text-[11px] text-muted-foreground truncate max-w-[200px]">
                        {agent.description}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          {/* File/folder items */}
          {!loading && !error && hasFiles && (
            <CommandGroup heading={hasAgents ? "Files" : undefined}>
              {filteredEntries.map((entry) => {
                const searchEntry = entry as Entry & { relativePath?: string };
                const emoji = !entry.isDirectory ? getFileIcon(entry.name) : null;
                const itemValue = isSearchMode ? (searchEntry.relativePath ?? entry.name) : entry.name;
                return (
                  <CommandItem
                    key={entry.path}
                    value={itemValue}
                    onSelect={() => handleSelectFile(searchEntry)}
                    className="cursor-pointer"
                    role="option"
                    aria-selected={highlightedValue === itemValue}
                  >
                    {entry.isDirectory ? (
                      <FolderIcon />
                    ) : (
                      <FileIcon />
                    )}
                    <span className="truncate flex-1">
                      {emoji && <span className="mr-1 text-xs">{emoji}</span>}
                      {isSearchMode && searchEntry.relativePath
                        ? searchEntry.relativePath
                        : entry.name}
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
