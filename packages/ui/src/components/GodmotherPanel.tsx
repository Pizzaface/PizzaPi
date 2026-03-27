import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Search, Loader2, Plus } from "lucide-react";
import { useServiceChannel } from "@/hooks/useServiceChannel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface GodmotherPanelProps {
    sessionId: string;
}

interface GodmotherIdea {
    id: string;
    project: string;
    status: string;
    topics: string[];
    snippet: string;
    created?: string;
    updated?: string;
    score?: number;
}

type ActionKind = "move" | "topic";

const STATUS_OPTIONS = [
    "capture",
    "triage",
    "design",
    "plan",
    "execute",
    "review",
    "shipped",
] as const;

const STATUS_BADGE_CLASS: Record<string, string> = {
    capture: "border-zinc-500/40 text-zinc-300",
    triage: "border-amber-500/40 text-amber-300",
    design: "border-fuchsia-500/40 text-fuchsia-300",
    plan: "border-cyan-500/40 text-cyan-300",
    execute: "border-blue-500/40 text-blue-300",
    review: "border-violet-500/40 text-violet-300",
    shipped: "border-emerald-500/40 text-emerald-300",
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseIdea(raw: unknown): GodmotherIdea | null {
    if (!isRecord(raw)) return null;
    const id = typeof raw.id === "string" ? raw.id : "";
    const status = typeof raw.status === "string" ? raw.status : "";
    if (!id || !status) return null;

    return {
        id,
        status,
        project: typeof raw.project === "string" && raw.project.trim().length > 0 ? raw.project : "PizzaPi",
        topics: Array.isArray(raw.topics)
            ? raw.topics.filter((topic): topic is string => typeof topic === "string" && topic.trim().length > 0)
            : [],
        snippet: typeof raw.snippet === "string" && raw.snippet.trim().length > 0 ? raw.snippet : "(no details)",
        ...(typeof raw.created === "string" ? { created: raw.created } : {}),
        ...(typeof raw.updated === "string" ? { updated: raw.updated } : {}),
        ...(typeof raw.score === "number" ? { score: raw.score } : {}),
    };
}

function parseIdeaList(raw: unknown): GodmotherIdea[] {
    if (!isRecord(raw) || !Array.isArray(raw.ideas)) return [];
    return raw.ideas
        .map(parseIdea)
        .filter((idea): idea is GodmotherIdea => idea !== null);
}

function mergeIdeaList(prev: GodmotherIdea[], nextIdea: GodmotherIdea): GodmotherIdea[] {
    const idx = prev.findIndex((idea) => idea.id === nextIdea.id);
    if (idx < 0) {
        return [nextIdea, ...prev].slice(0, 100);
    }
    const cloned = [...prev];
    cloned[idx] = nextIdea;
    return cloned;
}

function formatTimeLabel(iso?: string): string {
    if (!iso) return "";
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return "";
    const deltaMs = Date.now() - ts;
    const deltaMin = Math.max(1, Math.floor(deltaMs / 60_000));
    if (deltaMin < 60) return `${deltaMin}m ago`;
    const deltaHr = Math.floor(deltaMin / 60);
    if (deltaHr < 24) return `${deltaHr}h ago`;
    const deltaDay = Math.floor(deltaHr / 24);
    return `${deltaDay}d ago`;
}

export function GodmotherPanel(_props: GodmotherPanelProps) {
    const [ideas, setIdeas] = useState<GodmotherIdea[]>([]);
    const [queryInput, setQueryInput] = useState("");
    const [query, setQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [topicFilter, setTopicFilter] = useState("");
    const [includeCompleted, setIncludeCompleted] = useState(false);
    const [topicDrafts, setTopicDrafts] = useState<Record<string, string>>({});
    const [movingIds, setMovingIds] = useState<Set<string>>(new Set());
    const [savingTopicIds, setSavingTopicIds] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

    const requestCounterRef = useRef(0);
    const activeQueryRequestRef = useRef<string | null>(null);
    const pendingActionRequestsRef = useRef<Map<string, { kind: ActionKind; ideaId: string }>>(new Map());

    const { send, available } = useServiceChannel<unknown, unknown>("godmother", {
        onMessage: (type, payload, requestId) => {
            if (type === "godmother_query_result") {
                if (requestId && activeQueryRequestRef.current && requestId !== activeQueryRequestRef.current) {
                    return;
                }
                setIdeas(parseIdeaList(payload));
                setLoading(false);
                setError(null);
                setLastLoadedAt(Date.now());
                return;
            }

            if (type === "godmother_idea_updated") {
                if (isRecord(payload)) {
                    const idea = parseIdea(payload.idea);
                    if (idea) {
                        setIdeas((prev) => mergeIdeaList(prev, idea));
                        setLastLoadedAt(Date.now());
                    }
                }

                if (requestId) {
                    const pending = pendingActionRequestsRef.current.get(requestId);
                    if (pending) {
                        pendingActionRequestsRef.current.delete(requestId);
                        if (pending.kind === "move") {
                            setMovingIds((prev) => {
                                const next = new Set(prev);
                                next.delete(pending.ideaId);
                                return next;
                            });
                        } else {
                            setSavingTopicIds((prev) => {
                                const next = new Set(prev);
                                next.delete(pending.ideaId);
                                return next;
                            });
                            setTopicDrafts((prev) => ({ ...prev, [pending.ideaId]: "" }));
                        }
                    }
                }
                return;
            }

            if (type === "godmother_error") {
                const message = isRecord(payload) && typeof payload.error === "string"
                    ? payload.error
                    : "Godmother request failed";
                setError(message);

                if (requestId && activeQueryRequestRef.current === requestId) {
                    setLoading(false);
                }
                if (requestId) {
                    const pending = pendingActionRequestsRef.current.get(requestId);
                    if (pending) {
                        pendingActionRequestsRef.current.delete(requestId);
                        if (pending.kind === "move") {
                            setMovingIds((prev) => {
                                const next = new Set(prev);
                                next.delete(pending.ideaId);
                                return next;
                            });
                        } else {
                            setSavingTopicIds((prev) => {
                                const next = new Set(prev);
                                next.delete(pending.ideaId);
                                return next;
                            });
                        }
                    }
                }
            }
        },
    });

    useEffect(() => {
        const timer = setTimeout(() => {
            setQuery(queryInput.trim());
        }, 220);
        return () => clearTimeout(timer);
    }, [queryInput]);

    const queryPayload = useMemo(() => ({
        query: query.length > 0 ? query : undefined,
        status: statusFilter.length > 0 ? statusFilter : undefined,
        topic: topicFilter.trim().length > 0 ? topicFilter.trim().toLowerCase() : undefined,
        includeCompleted,
        limit: 80,
        project: "PizzaPi",
    }), [query, statusFilter, topicFilter, includeCompleted]);

    const sendQuery = useCallback(() => {
        if (!available) return;
        const requestId = `gm-q-${++requestCounterRef.current}`;
        activeQueryRequestRef.current = requestId;
        setLoading(true);
        setError(null);
        send("ideas_query", queryPayload, requestId);
    }, [available, send, queryPayload]);

    useEffect(() => {
        if (!available) {
            setLoading(false);
            return;
        }
        sendQuery();
    }, [available, sendQuery]);

    const handleMoveStatus = useCallback((idea: GodmotherIdea, nextStatus: string) => {
        if (!available || nextStatus === idea.status) return;

        const requestId = `gm-m-${++requestCounterRef.current}`;
        pendingActionRequestsRef.current.set(requestId, { kind: "move", ideaId: idea.id });
        setMovingIds((prev) => new Set(prev).add(idea.id));
        setError(null);
        send("idea_move_status", { id: idea.id, to: nextStatus }, requestId);
    }, [available, send]);

    const handleAddTopics = useCallback((ideaId: string) => {
        const draft = topicDrafts[ideaId] ?? "";
        const topics = draft
            .split(",")
            .map((item) => item.trim().toLowerCase().replace(/\s+/g, "-"))
            .filter((item) => item.length > 0);

        if (!available || topics.length === 0) return;

        const requestId = `gm-t-${++requestCounterRef.current}`;
        pendingActionRequestsRef.current.set(requestId, { kind: "topic", ideaId });
        setSavingTopicIds((prev) => new Set(prev).add(ideaId));
        setError(null);
        send("idea_add_topics", { id: ideaId, topics }, requestId);
    }, [available, send, topicDrafts]);

    if (!available) return null;

    return (
        <div className="flex h-full flex-col">
            <div className="shrink-0 border-b border-border bg-muted/20 px-3 py-2 space-y-2">
                <div className="flex items-center gap-1.5">
                    <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={queryInput}
                            onChange={(e) => setQueryInput(e.target.value)}
                            placeholder="Search ideas…"
                            className="h-7 pl-7 text-xs"
                        />
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-7 w-7"
                        onClick={sendQuery}
                        title="Refresh"
                    >
                        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                    </Button>
                </div>

                <div className="flex items-center gap-1.5">
                    <select
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                        className="h-7 w-28 rounded-md border border-input bg-background px-2 text-[11px]"
                        aria-label="Filter by status"
                    >
                        <option value="">All statuses</option>
                        {STATUS_OPTIONS.map((status) => (
                            <option key={status} value={status}>{status}</option>
                        ))}
                    </select>
                    <Input
                        value={topicFilter}
                        onChange={(e) => setTopicFilter(e.target.value)}
                        placeholder="Topic"
                        className="h-7 text-xs"
                    />
                    <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                        <input
                            type="checkbox"
                            checked={includeCompleted}
                            onChange={(e) => setIncludeCompleted(e.target.checked)}
                            className="h-3 w-3 accent-primary"
                        />
                        shipped
                    </label>
                </div>

                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>{ideas.length} idea{ideas.length === 1 ? "" : "s"}</span>
                    {lastLoadedAt ? <span>Updated {formatTimeLabel(new Date(lastLoadedAt).toISOString())}</span> : null}
                </div>

                {error ? <div className="text-[10px] text-destructive">{error}</div> : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-2">
                {ideas.length === 0 && !loading ? (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        No ideas match the current filters.
                    </div>
                ) : null}

                {ideas.map((idea) => {
                    const moving = movingIds.has(idea.id);
                    const savingTopics = savingTopicIds.has(idea.id);
                    const statusBadgeClass = STATUS_BADGE_CLASS[idea.status] ?? "border-zinc-500/40 text-zinc-300";

                    return (
                        <div key={idea.id} className="rounded-md border border-border bg-background p-2 space-y-2">
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="truncate font-mono text-[10px] text-muted-foreground">{idea.id}</div>
                                    <div className="truncate text-[10px] text-muted-foreground">
                                        {idea.project}
                                        {(idea.updated || idea.created) ? ` · ${formatTimeLabel(idea.updated ?? idea.created)}` : ""}
                                        {typeof idea.score === "number" ? ` · score ${idea.score.toFixed(2)}` : ""}
                                    </div>
                                </div>
                                <Badge variant="outline" className={`h-4 px-1.5 text-[9px] capitalize ${statusBadgeClass}`}>
                                    {idea.status}
                                </Badge>
                            </div>

                            <p className="text-[11px] leading-snug text-foreground/90 whitespace-pre-wrap break-words">
                                {idea.snippet}
                            </p>

                            {idea.topics.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                    {idea.topics.map((topic) => (
                                        <Badge key={`${idea.id}-${topic}`} variant="secondary" className="h-4 px-1.5 text-[9px] font-normal rounded-sm">
                                            #{topic}
                                        </Badge>
                                    ))}
                                </div>
                            ) : null}

                            <div className="grid grid-cols-[1fr_auto] items-center gap-1.5">
                                <select
                                    value={idea.status}
                                    onChange={(e) => handleMoveStatus(idea, e.target.value)}
                                    className="h-7 rounded-md border border-input bg-background px-2 text-[11px] capitalize"
                                    disabled={moving}
                                    aria-label={`Move status for ${idea.id}`}
                                >
                                    {STATUS_OPTIONS.map((status) => (
                                        <option key={status} value={status}>{status}</option>
                                    ))}
                                </select>
                                {moving ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
                            </div>

                            <div className="grid grid-cols-[1fr_auto] gap-1.5">
                                <Input
                                    value={topicDrafts[idea.id] ?? ""}
                                    onChange={(e) => setTopicDrafts((prev) => ({ ...prev, [idea.id]: e.target.value }))}
                                    placeholder="Add topics (comma-separated)"
                                    className="h-7 text-[11px]"
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            handleAddTopics(idea.id);
                                        }
                                    }}
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={() => handleAddTopics(idea.id)}
                                    disabled={savingTopics}
                                    title="Add topic tags"
                                >
                                    {savingTopics ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                                </Button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
