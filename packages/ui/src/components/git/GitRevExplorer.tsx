/**
 * GitRevExplorer — unified History/Compare/Diff modal.
 *
 * Three panes: commit graph (topology) | changed files | diff. Selecting one
 * commit shows its changes; a second selection (or a branch chip / Range bar)
 * establishes a Base→Head range that re-scopes immediately.
 */
import { useState, useCallback, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GitDiffCode } from "./GitDiffCode";
import { GitStatusIcon } from "./GitStatusIcon";
import { layoutGraph, type GraphRow } from "./git-graph";
import { Spinner } from "@/components/ui/spinner";
import { GitCommit, FileText, X } from "lucide-react";
import type { GitLogEntry } from "@/hooks/useGitService";

interface GitRevExplorerProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    cwd: string;
    log: GitLogEntry[];
    fetchLog: () => Promise<GitLogEntry[]>;
    fetchCommitFiles: (revision: string, base?: string) => Promise<Array<{ status: string; path: string }>>;
    fetchDiffRevs: (base: string, head: string, path?: string) => Promise<string>;
}

function short(h: string): string {
    return h.length > 7 ? h.slice(0, 7) : h;
}

export function GitRevExplorer({
    open,
    onOpenChange,
    log,
    fetchLog,
    fetchCommitFiles,
    fetchDiffRevs,
}: GitRevExplorerProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                showCloseButton={false}
                className="gap-0 p-0 overflow-hidden sm:max-w-[min(96vw,960px)] h-[min(88vh,760px)] flex flex-col"
            >
                <DialogTitle className="sr-only">Revision explorer</DialogTitle>
                <GitRevExplorerBody
                    onOpenChange={onOpenChange}
                    log={log}
                    fetchLog={fetchLog}
                    fetchCommitFiles={fetchCommitFiles}
                    fetchDiffRevs={fetchDiffRevs}
                />
            </DialogContent>
        </Dialog>
    );
}

interface GitRevExplorerBodyProps {
    onOpenChange: (open: boolean) => void;
    log: GitLogEntry[];
    fetchLog: () => Promise<GitLogEntry[]>;
    fetchCommitFiles: (revision: string, base?: string) => Promise<Array<{ status: string; path: string }>>;
    fetchDiffRevs: (base: string, head: string, path?: string) => Promise<string>;
}

/** The explorer's three-pane body — split from the Dialog for testability. */
export function GitRevExplorerBody({
    onOpenChange,
    log: initialLog,
    fetchLog,
    fetchCommitFiles,
    fetchDiffRevs,
}: GitRevExplorerBodyProps) {
    const [entries, setEntries] = useState<GitLogEntry[]>(initialLog);
    const [headHash, setHeadHash] = useState<string | null>(null);
    const [baseHash, setBaseHash] = useState<string | null>(null);
    const [files, setFiles] = useState<Array<{ status: string; path: string }>>([]);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [diff, setDiff] = useState("");
    const [logLoading, setLogLoading] = useState(false);
    const [filesLoading, setFilesLoading] = useState(false);
    const [diffLoading, setDiffLoading] = useState(false);

    // Load the log on mount.
    useEffect(() => {
        let cancelled = false;
        setLogLoading(true);
        fetchLog()
            .then((entries) => {
                if (cancelled) return;
                setEntries(entries);
                if (entries.length > 0) {
                    setHeadHash(entries[0].hash);
                    setBaseHash(null);
                }
            })
            .finally(() => {
                if (!cancelled) setLogLoading(false);
            });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const rows: GraphRow[] = useMemo(() => layoutGraph(entries), [entries]);

    const entriesByHash = useMemo(() => {
        const m = new Map<string, GitLogEntry>();
        for (const e of entries) m.set(e.hash, e);
        return m;
    }, [entries]);

    // Load the changed-files list for the current selection (fast — populates
    // the middle pane independently of the potentially large diff).
    useEffect(() => {
        if (!headHash) return;
        let cancelled = false;
        setFilesLoading(true);
        setSelectedFile(null);
        fetchCommitFiles(headHash, baseHash ?? undefined)
            .then((fileList) => { if (!cancelled) setFiles(fileList); })
            .finally(() => { if (!cancelled) setFilesLoading(false); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [headHash, baseHash]);

    // Load the diff separately, scoped to the selected file when one is picked.
    // A single commit diffs against its parent (parent → commit); a range diffs
    // base → head. Getting the direction right keeps additions green, not red.
    useEffect(() => {
        if (!headHash) return;
        let cancelled = false;
        setDiffLoading(true);
        const base = baseHash ?? `${headHash}^`;
        fetchDiffRevs(base, headHash, selectedFile ?? undefined)
            .then((diffText) => { if (!cancelled) setDiff(diffText); })
            .finally(() => { if (!cancelled) setDiffLoading(false); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [headHash, baseHash, selectedFile]);

    // Clicking a commit: in compare mode, first click sets Base, second sets Head.
    const selectCommit = useCallback(
        (hash: string) => {
            if (baseHash && hash !== baseHash) {
                setHeadHash(hash); // range re-scopes immediately
                return;
            }
            setBaseHash(null);
            setHeadHash(hash);
        },
        [baseHash],
    );

    // Branch chips: compare that branch → current head.
    const compareToBranch = useCallback(
        (branch: string) => {
            const target = entries.find((e) => e.refs.includes(branch));
            if (!target) return;
            setBaseHash(target.hash);
            if (!headHash) setHeadHash(target.hash);
        },
        [entries, headHash],
    );

    const headEntry = headHash ? entriesByHash.get(headHash) : undefined;
    const baseEntry = baseHash ? entriesByHash.get(baseHash) : undefined;
    const branchChips = useMemo(() => {
        const seen = new Set<string>();
        const chips: string[] = [];
        for (const e of entries) {
            for (const ref of e.refs) {
                if (ref === "HEAD" || seen.has(ref)) continue;
                seen.add(ref);
                chips.push(ref);
            }
        }
        return chips.slice(0, 8);
    }, [entries]);

    return (
        <div className="flex flex-col flex-1 min-h-0">
            {/* Header: range + close */}
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
                    <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">Range</span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-background border border-border text-xs font-mono text-foreground/80">
                        {baseEntry ? short(baseEntry.hash) : "…"}
                        <span className="text-muted-foreground">→</span>
                        {headEntry ? short(headEntry.hash) : "…"}
                    </span>
                    {branchChips.map((b) => (
                        <button
                            key={b}
                            type="button"
                            onClick={() => compareToBranch(b)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent text-[0.65rem] font-mono text-foreground/80 hover:bg-accent/70"
                            title={`Compare ${b} → current`}
                        >
                            <GitCommit className="size-2.5" /> {b}
                        </button>
                    ))}
                    <div className="flex-1" />
                    {baseHash && (
                        <button
                            type="button"
                            onClick={() => setBaseHash(null)}
                            className="text-[0.65rem] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent"
                            title="Exit compare mode"
                        >
                            Clear base
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => onOpenChange(false)}
                        className="flex-shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                        aria-label="Close revision explorer"
                    >
                        <X className="size-3.5" />
                    </button>
                </div>

                {logLoading && entries.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center">
                        <Spinner className="size-5" />
                    </div>
                ) : entries.length === 0 ? (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground gap-2">
                        <GitCommit className="size-6 opacity-40" />
                        <span className="text-sm">No commits found</span>
                    </div>
                ) : (
                    <div className="flex flex-1 min-h-0">
                        {/* Left: graph */}
                        <div className="w-[300px] shrink-0 border-r border-border flex flex-col min-h-0">
                            <div className="px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/60">
                                Commits
                            </div>
                            <ScrollArea className="flex-1">
                                <div className="py-1">
                                    {rows.map((row, i) => {
                                        const entry = entries[i];
                                        const isHead = entry.hash === headHash;
                                        const isBase = entry.hash === baseHash;
                                        return (
                                            <GraphRowView
                                                key={entry.hash}
                                                row={row}
                                                entry={entry}
                                                isHead={isHead}
                                                isBase={isBase}
                                                onClick={() => selectCommit(entry.hash)}
                                            />
                                        );
                                    })}
                                </div>
                            </ScrollArea>
                        </div>

                        {/* Middle: files */}
                        <div className="w-[200px] shrink-0 border-r border-border flex flex-col min-h-0">
                            <div className="px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/60">
                                {baseHash ? "Range files" : `${headEntry?.shortHash ?? ""} · ${files.length}`}
                            </div>
                            <ScrollArea className="flex-1">
                                <div className="py-1">
                                    {filesLoading && files.length === 0 && (
                                        <div className="flex items-center justify-center py-4"><Spinner className="size-4" /></div>
                                    )}
                                    {!filesLoading && files.length === 0 && (
                                        <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                                            No files changed
                                        </div>
                                    )}
                                    {files.length > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => setSelectedFile(null)}
                                            className={cn(
                                                "flex items-center gap-1.5 w-full px-3 py-1 text-left",
                                                selectedFile === null ? "bg-accent/70 text-foreground" : "hover:bg-accent/30 text-muted-foreground",
                                            )}
                                        >
                                            <FileText className="size-3 shrink-0" />
                                            <span className="truncate flex-1 text-xs">All changes ({files.length})</span>
                                        </button>
                                    )}
                                    {files.map((f) => (
                                        <button
                                            key={f.path}
                                            type="button"
                                            onClick={() => setSelectedFile(f.path)}
                                            className={cn(
                                                "flex items-center gap-1.5 w-full px-3 py-1 text-left",
                                                selectedFile === f.path ? "bg-accent/70" : "hover:bg-accent/30",
                                            )}
                                            title={f.path}
                                        >
                                            <GitStatusIcon status={f.status} staged={false} className="size-3" />
                                            <span className="truncate flex-1 text-xs font-mono text-foreground/80">{f.path.split("/").pop()}</span>
                                            <span className="text-[0.6rem] font-semibold text-muted-foreground shrink-0">
                                                {f.status.replace(/\d/g, "")}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </ScrollArea>
                        </div>

                        {/* Right: diff */}
                        <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-muted/10">
                            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/60 text-xs text-muted-foreground shrink-0">
                                <FileText className="size-3 shrink-0" />
                                <span className="truncate">{selectedFile ?? (baseHash ? "All changes in range" : "All changes in commit")}</span>
                            </div>
                            <GitDiffCode diff={diff} loading={diffLoading} className="flex-1" />
                        </div>
                    </div>
                )}
        </div>
    );
}

function GraphRowView({
    row,
    entry,
    isHead,
    isBase,
    onClick,
}: {
    row: GraphRow;
    entry: GitLogEntry;
    isHead: boolean;
    isBase: boolean;
    onClick: () => void;
}) {
    const laneCount = Math.max(
        row.nodeLane,
        ...row.lines,
        ...row.joins.map((j) => Math.max(j.from, j.to)),
    ) + 1;
    const width = laneCount * 16 + 8;

    const nodeColor = isBase ? "#60a5fa" : isHead ? "#4ade80" : "rgba(255,255,255,0.55)";

    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex items-center gap-1.5 w-full px-2 py-1.5 text-left rounded",
                (isHead || isBase) ? "bg-accent/70" : "hover:bg-accent/30",
            )}
        >
            <svg width={width} height="18" viewBox={`0 0 ${width} 18`} className="shrink-0">
                {(() => {
                    const segs: React.ReactNode[] = [];
                    const activeLanes = new Set<number>(row.lines);
                    activeLanes.add(row.nodeLane);
                    for (const j of row.joins) activeLanes.add(j.from);
                    for (const lane of activeLanes) {
                        const x = 4 + lane * 16;
                        segs.push(
                            <line key={`l${lane}`} x1={x} y1={0} x2={x} y2={18} stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />,
                        );
                    }
                    for (const j of row.joins) {
                        const fromX = 4 + j.from * 16;
                        const toX = 4 + j.to * 16;
                        segs.push(
                            <line key={`j${j.from}-${j.to}`} x1={fromX} y1={13} x2={toX} y2={13} stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />,
                        );
                    }
                    segs.push(
                        <circle key="node" cx={4 + row.nodeLane * 16} cy={13} r={isHead || isBase ? 3.4 : 2.6} fill={nodeColor} />,
                    );
                    return segs;
                })()}
            </svg>
            <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] text-foreground/90">{entry.subject}</div>
                <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
                    <span className="font-mono text-foreground/50">{entry.shortHash}</span>
                    <span>·</span>
                    <span>{formatRelative(entry.authorDate)}</span>
                    {entry.refs.length > 0 && (
                        <span className="flex items-center gap-0.5 ml-1 min-w-0">
                            {entry.refs.slice(0, 2).map((r) => (
                                <span key={r} className="px-1 rounded bg-accent font-mono text-foreground/60 text-[8px] truncate max-w-16">{r}</span>
                            ))}
                        </span>
                    )}
                </div>
            </div>
        </button>
    );
}

function formatRelative(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    const units: [Intl.RelativeTimeFormatUnit, number][] = [
        ["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60],
    ];
    for (const [u, t] of units) {
        const v = Math.floor(s / t);
        if (v >= 1) {
            try { return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-v, u); }
            catch { return `${v} ${u}${v > 1 ? "s" : ""} ago`; }
        }
    }
    return iso;
}
