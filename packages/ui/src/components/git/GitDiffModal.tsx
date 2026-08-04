import { useState, useMemo, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GitDiffCode } from "./GitDiffCode";
import { GitStatusIcon, isStagedChange } from "./GitStatusIcon";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import type { GitChange } from "@/hooks/useGitService";

interface GitDiffModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The current working-tree changes to browse in the left pane. */
    changes: GitChange[];
    initialPath?: string;
    initialStaged?: boolean;
    fetchDiff: (path: string, staged?: boolean) => Promise<string>;
}

// ── Folder tree builder (directory → files) ────────────────────────────────

interface DirNode { name: string; fullPath: string; children: (DirNode | FileNode)[] }
interface FileNode { name: string; fullPath: string; change: GitChange; staged: boolean }
type TreeNode = DirNode | FileNode;

function buildTree(changes: GitChange[]): DirNode {
    const root: DirNode = { name: "", fullPath: "", children: [] };
    for (const change of changes) {
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
        const staged = isStagedChange(change.status);
        current.children.push({
            name: parts[parts.length - 1],
            fullPath: change.path,
            change,
            staged,
        });
    }
    const sort = (node: DirNode) => {
        node.children.sort((a, b) => {
            const aDir = (a as DirNode).children !== undefined;
            const bDir = (b as DirNode).children !== undefined;
            if (aDir !== bDir) return aDir ? -1 : 1;
            return a.name.localeCompare(b.name);
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
    fetchDiff,
}: GitDiffModalProps) {
    const [selectedPath, setSelectedPath] = useState<string | null>(initialPath ?? null);
    const [selectedStaged, setSelectedStaged] = useState(initialStaged);
    const [diff, setDiff] = useState("");
    const [loading, setLoading] = useState(false);
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["packages"]));

    const tree = useMemo(() => buildTree(changes), [changes]);

    // Reset selection when the modal opens.
    useEffect(() => {
        if (open) {
            setSelectedPath(initialPath ?? null);
            setSelectedStaged(initialStaged);
            setDiff("");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const loadDiff = useCallback(
        async (path: string, staged: boolean) => {
            setSelectedPath(path);
            setSelectedStaged(staged);
            setLoading(true);
            const result = await fetchDiff(path, staged);
            setDiff(result || "(no diff)");
            setLoading(false);
        },
        [fetchDiff],
    );

    // Load the initial file's diff on open.
    useEffect(() => {
        if (!open) return;
        if (initialPath) {
            void loadDiff(initialPath, initialStaged);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, initialPath]);

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
                className="gap-0 p-0 overflow-hidden sm:max-w-4xl h-[min(85vh,720px)] flex flex-col"
                onEscapeKeyDown={(e) => e.preventDefault()}
            >
                <DialogTitle className="sr-only">File diff viewer</DialogTitle>

                {/* Header */}
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
                    <span className="truncate flex-1 min-w-0 text-xs font-mono text-muted-foreground">
                        {selectedPath ?? "Select a file"}
                        {selectedStaged && <span className="ml-1 text-green-600 dark:text-green-400">(staged)</span>}
                    </span>
                    <button
                        type="button"
                        onClick={() => onOpenChange(false)}
                        className="flex-shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                        aria-label="Close diff viewer"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                    </button>
                </div>

                {/* Body: two panes */}
                <div className="flex flex-1 min-h-0">
                    {/* Left: change tree */}
                    <div className="w-[200px] shrink-0 border-r border-border flex flex-col min-h-0">
                        <div className="px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/60">
                            Files ({changes.length})
                        </div>
                        <ScrollArea className="flex-1">
                            <div className="py-1">
                                {tree.children.map((node) => (
                                    <TreeRow
                                        key={node.fullPath}
                                        node={node}
                                        depth={0}
                                        selectedPath={selectedPath}
                                        expanded={expanded}
                                        onToggleExpand={toggleExpand}
                                        onSelect={(path, staged) => void loadDiff(path, staged)}
                                    />
                                ))}
                            </div>
                        </ScrollArea>
                    </div>

                    {/* Right: diff */}
                    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-muted/10">
                        <GitDiffCode diff={diff} loading={loading} className="flex-1" />
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function TreeRow({
    node,
    depth,
    selectedPath,
    expanded,
    onToggleExpand,
    onSelect,
}: {
    node: TreeNode;
    depth: number;
    selectedPath: string | null;
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
                    onClick={() => onToggleExpand(dir.fullPath)}
                    className="flex items-center gap-1 w-full px-2 py-1 text-left hover:bg-accent/40 rounded"
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
                            key={child.fullPath}
                            node={child}
                            depth={depth + 1}
                            selectedPath={selectedPath}
                            expanded={expanded}
                            onToggleExpand={onToggleExpand}
                            onSelect={onSelect}
                        />
                    ))}
            </div>
        );
    }

    const file = node as FileNode;
    const isSelected = selectedPath === file.fullPath;
    return (
        <button
            type="button"
            onClick={() => onSelect(file.fullPath, file.staged)}
            className={cn(
                "flex items-center gap-1.5 w-full px-2 py-1 text-left rounded",
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
