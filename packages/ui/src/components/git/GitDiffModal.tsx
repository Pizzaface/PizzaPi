import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GitDiffCode } from "./GitDiffCode";
import { GitStatusIcon, isStagedChange } from "./GitStatusIcon";
import { partitionChanges } from "./GitStagingArea";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import type { GitChange } from "@/hooks/useGitService";

interface GitDiffModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The current working-tree changes to browse in the left pane. */
    changes: GitChange[];
    initialPath?: string;
    initialStaged?: boolean;
    /** Changes when the parent knows the selected diff should be reloaded. */
    refreshKey?: string | number;
    fetchDiff: (path: string, staged?: boolean) => Promise<string>;
}

// ── Folder tree builder (directory → files) ────────────────────────────────

interface DirNode { name: string; fullPath: string; children: (DirNode | FileNode)[] }
interface FileNode { name: string; fullPath: string; key: string; change: GitChange; staged: boolean }
type TreeNode = DirNode | FileNode;
interface ChangeSide { key: string; change: GitChange; staged: boolean }
interface Selection { path: string; staged: boolean }

function selectionKey(path: string, staged: boolean): string {
    return `${staged ? "staged" : "unstaged"}:${path}`;
}

function sameSelection(a: Selection | null, b: Selection | null): boolean {
    return a?.path === b?.path && a?.staged === b?.staged;
}

function toChangeSides(changes: GitChange[]): ChangeSide[] {
    const { staged, unstaged } = partitionChanges(changes);
    const sides: ChangeSide[] = [];
    const seen = new Set<string>();
    const seenPaths = new Set<string>();
    const add = (change: GitChange, stagedSide: boolean) => {
        const key = selectionKey(change.path, stagedSide);
        if (seen.has(key)) return;
        seen.add(key);
        seenPaths.add(change.path);
        sides.push({ key, change, staged: stagedSide });
    };

    for (const change of staged) add(change, true);
    for (const change of unstaged) add(change, false);

    // Older/non-porcelain callers may pass one-letter statuses. Keep them browsable.
    for (const change of changes) {
        if (seenPaths.has(change.path)) continue;
        add(change, isStagedChange(change.status));
    }

    return sides;
}

function findSelection(sides: ChangeSide[], desired: Selection | null): Selection | null {
    if (!desired) return null;
    const exact = sides.find((side) => side.change.path === desired.path && side.staged === desired.staged);
    const samePath = exact ?? sides.find((side) => side.change.path === desired.path);
    return samePath ? { path: samePath.change.path, staged: samePath.staged } : null;
}

function firstSelection(sides: ChangeSide[]): Selection | null {
    const first = sides[0];
    return first ? { path: first.change.path, staged: first.staged } : null;
}

function ancestorsForPath(path: string): string[] {
    const parts = path.split("/");
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function buildTree(sides: ChangeSide[]): DirNode {
    const root: DirNode = { name: "", fullPath: "", children: [] };
    for (const side of sides) {
        const { change } = side;
        const parts = change.path.split("/");
        let current = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const dirName = parts[i];
            const dirPath = parts.slice(0, i + 1).join("/");
            let child = current.children.find(
                (c): c is DirNode => "children" in c && (c as DirNode).fullPath === dirPath,
            ) as DirNode | undefined;
            if (!child) {
                child = { name: dirName, fullPath: dirPath, children: [] };
                current.children.push(child);
            }
            current = child;
        }
        current.children.push({
            name: parts[parts.length - 1],
            fullPath: change.path,
            key: side.key,
            change,
            staged: side.staged,
        });
    }
    const sort = (node: DirNode) => {
        node.children.sort((a, b) => {
            const aDir = (a as DirNode).children !== undefined;
            const bDir = (b as DirNode).children !== undefined;
            if (aDir !== bDir) return aDir ? -1 : 1;
            if (a.name !== b.name) return a.name.localeCompare(b.name);
            const aStaged = (a as FileNode).staged ?? false;
            const bStaged = (b as FileNode).staged ?? false;
            return Number(bStaged) - Number(aStaged);
        });
        for (const c of node.children) if ((c as DirNode).children) sort(c as DirNode);
    };
    sort(root);
    return root;
}

// ── Component ───────────────────────────────────────────────────────────────

export function GitDiffModal({
    open,
    onOpenChange,
    changes,
    initialPath,
    initialStaged = false,
    refreshKey,
    fetchDiff,
}: GitDiffModalProps) {
    const requestedSelection = useMemo<Selection | null>(
        () => (initialPath ? { path: initialPath, staged: initialStaged } : null),
        [initialPath, initialStaged],
    );
    const requestedKey = requestedSelection ? selectionKey(requestedSelection.path, requestedSelection.staged) : "";
    const lastRequestedKey = useRef(requestedKey);
    const changeSides = useMemo(() => toChangeSides(changes), [changes]);
    const tree = useMemo(() => buildTree(changeSides), [changeSides]);

    const [selected, setSelected] = useState<Selection | null>(() => findSelection(changeSides, requestedSelection));
    const [diff, setDiff] = useState("");
    const displayedSelection = useRef<Selection | null>(null);
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["packages"]));

    useEffect(() => {
        if (!open) {
            setSelected(null);
            setDiff("");
            setLoading(false);
            lastRequestedKey.current = requestedKey;
            return;
        }

        const requestedChanged = lastRequestedKey.current !== requestedKey;
        lastRequestedKey.current = requestedKey;
        setSelected((previous) => {
            const next = requestedChanged
                ? findSelection(changeSides, requestedSelection) ?? firstSelection(changeSides)
                : findSelection(changeSides, previous) ?? findSelection(changeSides, requestedSelection) ?? firstSelection(changeSides);
            return sameSelection(previous, next) ? previous : next;
        });
    }, [open, changeSides, requestedKey, requestedSelection]);

    useEffect(() => {
        if (!open || selected) return;
        setDiff("");
        setLoading(false);
    }, [open, selected]);

    useEffect(() => {
        if (!open || !selected) return;
        setExpanded((previous) => {
            const next = new Set(previous);
            for (const path of ancestorsForPath(selected.path)) next.add(path);
            return next;
        });
    }, [open, selected]);

    useEffect(() => {
        if (!open || !selected) return;

        let cancelled = false;
        setLoading(true);
        if (!sameSelection(displayedSelection.current, selected)) setDiff("");
        displayedSelection.current = selected;

        void fetchDiff(selected.path, selected.staged)
            .then((result) => {
                if (!cancelled) setDiff(result || "(no diff)");
            })
            .catch((err: unknown) => {
                console.error("Failed to load git diff:", err);
                if (!cancelled) setDiff("Failed to load diff.");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [open, selected, fetchDiff, refreshKey]);

    const toggleExpand = useCallback((path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className="gap-0 p-0 overflow-hidden sm:max-w-4xl h-[min(88vh,720px)] flex flex-col"
            >
                <DialogTitle className="sr-only">File diff viewer</DialogTitle>
                <DialogDescription className="sr-only">Browse staged and unstaged file diffs.</DialogDescription>

                {/* Header */}
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
                    <span className="truncate flex-1 min-w-0 text-xs font-mono text-muted-foreground" aria-live="polite">
                        {selected?.path ?? "Select a file"}
                        {selected && <span className={cn("ml-1", selected.staged ? "text-green-600 dark:text-green-400" : "text-muted-foreground")}>
                            ({selected.staged ? "staged" : "unstaged"})
                        </span>}
                    </span>
                    <button
                        type="button"
                        onClick={() => onOpenChange(false)}
                        className="flex-shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
                        aria-label="Close diff viewer"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                    </button>
                </div>

                {/* Body: two panes */}
                <div className="flex flex-col md:flex-row flex-1 min-h-0">
                    {/* Left: change tree */}
                    <div className="w-full md:w-56 shrink-0 border-b md:border-b-0 md:border-r border-border flex flex-col h-40 md:h-auto md:min-h-0">
                        <div className="px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/60">
                            Files ({changeSides.length})
                        </div>
                        <ScrollArea className="flex-1">
                            <div className="py-1" aria-label="Changed files">
                                {tree.children.map((node) => (
                                    <TreeRow
                                        key={(node as FileNode).key ?? `dir-${node.fullPath}`}
                                        node={node}
                                        depth={0}
                                        selected={selected}
                                        expanded={expanded}
                                        onToggleExpand={toggleExpand}
                                        onSelect={(path, staged) => setSelected({ path, staged })}
                                    />
                                ))}
                            </div>
                        </ScrollArea>
                    </div>

                    {/* Right: diff */}
                    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-muted/10" aria-busy={loading}>
                        <GitDiffCode diff={diff} loading={loading && !diff} className="flex-1" />
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function TreeRow({
    node,
    depth,
    selected,
    expanded,
    onToggleExpand,
    onSelect,
}: {
    node: TreeNode;
    depth: number;
    selected: Selection | null;
    expanded: Set<string>;
    onToggleExpand: (path: string) => void;
    onSelect: (path: string, staged: boolean) => void;
}) {
    const isDir = (node as DirNode).children !== undefined;
    const padding = 8 + depth * 14;

    if (isDir) {
        const dir = node as DirNode;
        const isExpanded = expanded.has(dir.fullPath);
        return (
            <div>
                <button
                    type="button"
                    aria-expanded={isExpanded}
                    onClick={() => onToggleExpand(dir.fullPath)}
                    className="flex items-center gap-1 w-full px-2 py-1 text-left hover:bg-accent/40 rounded focus:outline-none focus:ring-2 focus:ring-ring"
                    style={{ paddingLeft: padding }}
                >
                    {isExpanded ? (
                        <ChevronDown className="size-3 text-muted-foreground shrink-0" />
                    ) : (
                        <ChevronRight className="size-3 text-muted-foreground shrink-0" />
                    )}
                    <Folder className="size-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate text-xs text-foreground/70">{dir.name}</span>
                </button>
                {isExpanded &&
                    dir.children.map((child) => (
                        <TreeRow
                            key={(child as FileNode).key ?? `dir-${child.fullPath}`}
                            node={child}
                            depth={depth + 1}
                            selected={selected}
                            expanded={expanded}
                            onToggleExpand={onToggleExpand}
                            onSelect={onSelect}
                        />
                    ))}
            </div>
        );
    }

    const file = node as FileNode;
    const isSelected = selected?.path === file.fullPath && selected.staged === file.staged;
    const side = file.staged ? "staged" : "unstaged";
    return (
        <button
            type="button"
            aria-label={`View ${side} diff for ${file.fullPath}`}
            aria-pressed={isSelected}
            onClick={() => onSelect(file.fullPath, file.staged)}
            className={cn(
                "flex items-center gap-1.5 w-full px-2 py-1 text-left rounded focus:outline-none focus:ring-2 focus:ring-ring",
                isSelected ? "bg-accent/70 text-foreground" : "hover:bg-accent/40",
            )}
            style={{ paddingLeft: padding }}
        >
            <GitStatusIcon status={file.change.status} staged={file.staged} className="size-3 shrink-0" />
            <span className="truncate flex-1 text-xs font-mono text-foreground/80">{file.name}</span>
            <span className={cn("text-[0.6rem] font-semibold shrink-0", file.staged ? "text-green-600 dark:text-green-400" : "text-muted-foreground")}>
                {file.staged ? file.change.status[0] : file.change.status === "??" ? "??" : file.change.status[1] ?? file.change.status[0]}
            </span>
        </button>
    );
}
