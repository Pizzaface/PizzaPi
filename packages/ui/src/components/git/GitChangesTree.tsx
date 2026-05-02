/**
 * GitChangesTree — tree view for git changes.
 *
 * Groups flat GitChange[] by directory into an expandable tree.
 * Each leaf node supports the same stage/unstage/diff actions as the flat list.
 */
import { useState, useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";
import {
    ChevronDown,
    ChevronRight,
    Folder,
    Plus,
    Minus,
    Edit3,
    FileQuestion,
    File,
} from "lucide-react";
import type { GitChange } from "@/hooks/useGitService";

// ── Tree node types ─────────────────────────────────────────────────────────

interface DirectoryNode {
    type: "directory";
    name: string;
    fullPath: string;
    children: TreeNode[];
}

interface FileNode {
    type: "file";
    name: string;
    fullPath: string;
    change: GitChange;
    staged: boolean;
}

type TreeNode = DirectoryNode | FileNode;

// ── Build tree from flat changes ────────────────────────────────────────────

interface StagedChange {
    change: GitChange;
    isStaged: boolean;
}

function buildTree(
    changes: StagedChange[],
): DirectoryNode {
    const root: DirectoryNode = { type: "directory", name: "", fullPath: "", children: [] };

    for (const { change, isStaged } of changes) {
        const parts = change.path.split("/");
        let current = root;

        // Walk/create directory path
        for (let i = 0; i < parts.length - 1; i++) {
            const dirName = parts[i];
            const dirPath = parts.slice(0, i + 1).join("/");
            let child = current.children.find(
                (c) => c.type === "directory" && c.name === dirName,
            ) as DirectoryNode | undefined;

            if (!child) {
                child = { type: "directory", name: dirName, fullPath: dirPath, children: [] };
                current.children.push(child);
            }
            current = child;
        }

        // Add file leaf — use a stable key (path + staged side) so partially
        // staged files (MM) appear as two distinct nodes.
        const fileName = parts[parts.length - 1];
        current.children.push({
            type: "file",
            name: fileName,
            fullPath: change.path,
            change,
            staged: isStaged,
        });
    }

    return root;
}

/** Sort directory children: directories first (alphabetical), then files (alphabetical) */
function sortTree(node: DirectoryNode): void {
    node.children.sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
    });
    for (const child of node.children) {
        if (child.type === "directory") sortTree(child);
    }
}

// ── Status icon helper (smaller version) ────────────────────────────────────

function statusIcon(status: string, staged: boolean) {
    // Determine the display status character
    const displayStatus = status === "??"
        ? "?"
        : staged
            ? status[0]
            : status.length === 2
                ? status[1]
                : status;

    switch (displayStatus) {
        case "M":
            return <Edit3 className="size-3 text-amber-500 dark:text-amber-400" />;
        case "A":
            return <Plus className="size-3 text-green-600 dark:text-green-400" />;
        case "D":
            return <Minus className="size-3 text-red-500 dark:text-red-400" />;
        case "?":
            return <FileQuestion className="size-3 text-muted-foreground" />;
        default:
            return <File className="size-3 text-muted-foreground" />;
    }
}

// ── Props ───────────────────────────────────────────────────────────────────

interface GitChangesTreeProps {
    changes: StagedChange[];
    onViewDiff: (path: string, staged?: boolean) => void;
    onStage: (paths: string[]) => void;
    onUnstage: (paths: string[]) => void;
    operationInProgress: string | null;
}

// ── Component ───────────────────────────────────────────────────────────────

export function GitChangesTree({
    changes,
    onViewDiff,
    onStage,
    onUnstage,
    operationInProgress,
}: GitChangesTreeProps) {
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
    const isBusy = operationInProgress !== null;

    const tree = useMemo(() => {
        const root = buildTree(changes);
        sortTree(root);
        return root;
    }, [changes]);

    const toggleExpand = useCallback((path: string) => {
        setExpandedPaths((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    return (
        <div className="py-1">
            {tree.children.length === 0 ? (
                <div className="px-3 py-4 text-xs text-muted-foreground text-center">No changes</div>
            ) : (
                tree.children.map((child) => (
                    <TreeNodeComponent
                        key={child.type === "directory" ? `dir-${child.fullPath}` : `file-${child.fullPath}-${(child as FileNode).staged ?? ""}`}
                        node={child}
                        depth={0}
                        expandedPaths={expandedPaths}
                        onToggleExpand={toggleExpand}
                        onViewDiff={onViewDiff}
                        onStage={onStage}
                        onUnstage={onUnstage}
                        isBusy={isBusy}
                    />
                ))
            )}
        </div>
    );
}

// ── Tree node renderer ───────────────────────────────────────────────────────

interface TreeNodeComponentProps {
    node: TreeNode;
    depth: number;
    expandedPaths: Set<string>;
    onToggleExpand: (path: string) => void;
    onViewDiff: (path: string, staged?: boolean) => void;
    onStage: (paths: string[]) => void;
    onUnstage: (paths: string[]) => void;
    isBusy: boolean;
}

function TreeNodeComponent({
    node,
    depth,
    expandedPaths,
    onToggleExpand,
    onViewDiff,
    onStage,
    onUnstage,
    isBusy,
}: TreeNodeComponentProps) {
    if (node.type === "directory") {
        const isExpanded = expandedPaths.has(node.fullPath);

        // Collect all file nodes under this directory for directory-level stage/unstage
        const collectFileNodes = (dir: DirectoryNode): FileNode[] => {
            const files: FileNode[] = [];
            for (const child of dir.children) {
                if (child.type === "file") files.push(child);
                else files.push(...collectFileNodes(child));
            }
            return files;
        };

        const allFileNodes = collectFileNodes(node);
        const allStaged = allFileNodes.length > 0 && allFileNodes.every((f) => f.staged);
        const hasUnstaged = allFileNodes.some((f) => !f.staged);
        const allFilePaths = allFileNodes.map((f) => f.fullPath);

        return (
            <div>
                <div
                    className="flex items-center gap-1 w-full px-3 py-1 text-sm group"
                    style={{ paddingLeft: `${depth * 12 + 12}px` }}
                >
                    <button
                        type="button"
                        onClick={() => onToggleExpand(node.fullPath)}
                        className="flex items-center gap-1.5 flex-1 min-w-0 text-left hover:bg-accent/40 rounded px-1 py-0.5 transition-colors"
                    >
                        {isExpanded ? (
                            <ChevronDown className="size-3 text-muted-foreground" />
                        ) : (
                            <ChevronRight className="size-3 text-muted-foreground" />
                        )}
                        <Folder className="size-3.5 text-muted-foreground" />
                        <span className="truncate font-mono text-xs text-foreground/80">{node.name}</span>
                        <span className="text-[0.6rem] text-muted-foreground ml-1">({allFilePaths.length})</span>
                    </button>

                    {/* Directory-level stage/unstage */}
                    {!allStaged && hasUnstaged && (
                        <button
                            type="button"
                            onClick={() => onStage(allFilePaths)}
                            disabled={isBusy}
                            className="flex-shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                            title={`Stage all in ${node.name}`}
                        >
                            <Plus className="size-3" />
                        </button>
                    )}
                    {allStaged && (
                        <button
                            type="button"
                            onClick={() => onUnstage(allFilePaths)}
                            disabled={isBusy}
                            className="flex-shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                            title={`Unstage all in ${node.name}`}
                        >
                            <Minus className="size-3" />
                        </button>
                    )}
                </div>

                {isExpanded && node.children.map((child) => (
                    <TreeNodeComponent
                        key={child.type === "directory" ? `dir-${child.fullPath}` : `file-${child.fullPath}-${(child as FileNode).staged ?? ""}`}
                        node={child}
                        depth={depth + 1}
                        expandedPaths={expandedPaths}
                        onToggleExpand={onToggleExpand}
                        onViewDiff={onViewDiff}
                        onStage={onStage}
                        onUnstage={onUnstage}
                        isBusy={isBusy}
                    />
                ))}
            </div>
        );
    }

    // File node
    const isUntracked = node.change.status === "??";
    const displayStatus = isUntracked
        ? "?"
        : node.staged
            ? node.change.status[0]
            : node.change.status.length === 2
                ? node.change.status[1]
                : node.change.status;

    return (
        <div
            className="flex items-center gap-1 w-full px-3 py-1 text-sm group"
            style={{ paddingLeft: `${depth * 12 + 12}px` }}
        >
            {/* Stage/unstage button */}
            {node.staged ? (
                <button
                    type="button"
                    onClick={() => onUnstage([node.fullPath])}
                    disabled={isBusy}
                    className="flex-shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                    title={`Unstage ${node.fullPath}`}
                >
                    <Minus className="size-3" />
                </button>
            ) : (
                <button
                    type="button"
                    onClick={() => onStage([node.fullPath])}
                    disabled={isBusy}
                    className="flex-shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                    title={`Stage ${node.fullPath}`}
                >
                    <Plus className="size-3" />
                </button>
            )}

            {/* File name + diff button */}
            <button
                type="button"
                onClick={() => !isUntracked && onViewDiff(node.fullPath, node.staged)}
                disabled={isUntracked}
                className={cn(
                    "flex items-center gap-2 flex-1 min-w-0 text-left rounded px-1 py-0.5 transition-colors",
                    !isUntracked && "hover:bg-accent/40",
                    isUntracked && "cursor-default",
                )}
            >
                <span className="flex-shrink-0">{statusIcon(node.change.status, node.staged)}</span>
                <span className="truncate flex-1 font-mono text-xs text-foreground/80">{node.name}</span>
                <span className={cn(
                    "text-[0.6rem] flex-shrink-0",
                    node.staged ? "text-green-600 dark:text-green-400" : "text-muted-foreground",
                )}>{displayStatus}</span>
            </button>
        </div>
    );
}