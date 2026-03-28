import * as React from "react";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RevealedSecretBanner } from "@/components/ui/revealed-secret";
import { Spinner } from "@/components/ui/spinner";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatPathTail } from "@/lib/path";
import { filterFolders } from "@/lib/filterFolders";
import {
    Webhook as WebhookIcon,
    Plus,
    Trash2,
    Copy,
    Check,
    ChevronDown,
    ChevronUp,
    FolderOpen,
    Filter,
    MessageSquare,
    Loader2,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebhookData {
    id: string;
    userId: string;
    name: string;
    secret: string;
    eventFilter: string[] | null;
    source: string;
    runnerId: string | null;
    cwd: string | null;
    prompt: string | null;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchWebhooks(): Promise<WebhookData[]> {
    const res = await fetch("/api/webhooks", { credentials: "include" });
    if (!res.ok) throw new Error("Failed to load webhooks");
    const data = await res.json();
    return data.webhooks ?? [];
}

async function createWebhookApi(input: {
    name: string;
    source: string;
    runnerId?: string | null;
    cwd?: string | null;
    prompt?: string | null;
    eventFilter?: string[] | null;
}): Promise<WebhookData> {
    const res = await fetch("/api/webhooks", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to create webhook");
    }
    const data = await res.json();
    return data.webhook;
}

async function updateWebhookApi(
    id: string,
    input: Record<string, unknown>,
): Promise<WebhookData> {
    const res = await fetch(`/api/webhooks/${encodeURIComponent(id)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to update webhook");
    }
    const data = await res.json();
    return data.webhook;
}

async function deleteWebhookApi(id: string): Promise<void> {
    const res = await fetch(`/api/webhooks/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to delete webhook");
    }
}

// ---------------------------------------------------------------------------
// DeleteButton (two-step confirmation)
// ---------------------------------------------------------------------------

function DeleteButton({
    onDelete,
    isDeleting,
}: {
    onDelete: () => void;
    isDeleting: boolean;
}) {
    const [confirming, setConfirming] = useState(false);

    useEffect(() => {
        if (!confirming) return;
        const timer = setTimeout(() => setConfirming(false), 3000);
        return () => clearTimeout(timer);
    }, [confirming]);

    if (isDeleting) {
        return (
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-destructive" disabled>
                <Spinner className="h-3.5 w-3.5" />
            </Button>
        );
    }

    if (confirming) {
        return (
            <Button
                variant="destructive"
                size="sm"
                className="h-7 px-2 text-xs animate-in fade-in zoom-in duration-200"
                onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                    setConfirming(false);
                }}
            >
                Sure?
            </Button>
        );
    }

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                        onClick={(e) => {
                            e.stopPropagation();
                            setConfirming(true);
                        }}
                        aria-label="Delete webhook"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Delete webhook</TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={handleCopy}
                        aria-label={label}
                    >
                        {copied ? (
                            <Check className="h-3.5 w-3.5 text-green-600" />
                        ) : (
                            <Copy className="h-3.5 w-3.5" />
                        )}
                    </Button>
                </TooltipTrigger>
                <TooltipContent>{copied ? "Copied!" : label}</TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

// ---------------------------------------------------------------------------
// WebhookRow
// ---------------------------------------------------------------------------

function WebhookRow({
    webhook,
    onToggle,
    onDelete,
    isDeleting,
    isToggling,
}: {
    webhook: WebhookData;
    onToggle: (enabled: boolean) => void;
    onDelete: () => void;
    isDeleting: boolean;
    isToggling: boolean;
}) {
    const [expanded, setExpanded] = useState(false);

    const fireUrl = `${window.location.origin}/api/webhooks/${webhook.id}/fire`;

    const curlSnippet = [
        `BODY='{"type":"example","data":{}}'`,
        `SECRET="${webhook.secret}"`,
        `# Works with both LibreSSL (macOS default) and OpenSSL 3.x`,
        `SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')`,
        ``,
        `curl -X POST ${fireUrl} \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "X-Webhook-Signature: $SIG" \\`,
        `  -d "$BODY"`,
    ].join("\n");

    return (
        <div
            className={cn(
                "rounded-lg border transition-colors",
                webhook.enabled
                    ? "border-border/40 bg-white/[0.02]"
                    : "border-border/20 bg-muted/10 opacity-60",
            )}
        >
            {/* Main row */}
            <div className="flex items-center gap-3 px-3 py-2.5">
                <WebhookIcon className="h-4 w-4 shrink-0 text-muted-foreground" />

                {/* Name + meta */}
                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{webhook.name}</span>
                        <span className="text-[10px] font-mono bg-muted/60 px-1.5 py-0.5 rounded border border-border/30 text-muted-foreground">
                            {webhook.source}
                        </span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                        {webhook.cwd && (
                            <span className="flex items-center gap-0.5 font-mono truncate max-w-48">
                                <FolderOpen className="h-2.5 w-2.5 shrink-0" />
                                {webhook.cwd}
                            </span>
                        )}
                        {webhook.prompt && (
                            <span className="flex items-center gap-0.5 truncate max-w-48">
                                <MessageSquare className="h-2.5 w-2.5 shrink-0" />
                                {webhook.prompt.length > 40
                                    ? webhook.prompt.slice(0, 40) + "…"
                                    : webhook.prompt}
                            </span>
                        )}
                        {webhook.eventFilter && webhook.eventFilter.length > 0 && (
                            <span className="flex items-center gap-0.5">
                                <Filter className="h-2.5 w-2.5 shrink-0" />
                                {webhook.eventFilter.join(", ")}
                            </span>
                        )}
                    </div>
                </div>

                {/* Toggle */}
                <Switch
                    checked={webhook.enabled}
                    onCheckedChange={onToggle}
                    disabled={isToggling}
                />

                {/* Expand */}
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => setExpanded(!expanded)}
                    aria-label={expanded ? "Collapse" : "Expand"}
                >
                    {expanded ? (
                        <ChevronUp className="h-3.5 w-3.5" />
                    ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                    )}
                </Button>

                {/* Delete */}
                <DeleteButton onDelete={onDelete} isDeleting={isDeleting} />
            </div>

            {/* Expanded detail */}
            {expanded && (
                <div className="border-t border-border/30 px-3 py-3 space-y-3">
                    {/* Project */}
                    {webhook.cwd && (
                        <div className="space-y-1">
                            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                                Project
                            </label>
                            <code className="block text-[11px] font-mono bg-muted/40 px-2 py-1 rounded border border-border/30">
                                {webhook.cwd}
                            </code>
                        </div>
                    )}

                    {/* Prompt */}
                    {webhook.prompt && (
                        <div className="space-y-1">
                            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                                Prompt
                            </label>
                            <pre className="text-[11px] font-mono bg-muted/40 px-2 py-1.5 rounded border border-border/30 whitespace-pre-wrap text-muted-foreground leading-relaxed">
                                {webhook.prompt}
                            </pre>
                        </div>
                    )}

                    {/* Fire URL */}
                    <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                            Fire URL
                        </label>
                        <div className="flex items-center gap-1.5">
                            <code className="flex-1 text-[11px] font-mono bg-muted/40 px-2 py-1 rounded border border-border/30 truncate select-all">
                                {fireUrl}
                            </code>
                            <CopyButton text={fireUrl} label="Copy URL" />
                        </div>
                    </div>

                    {/* Secret */}
                    <div className="space-y-1">
                        <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                            HMAC Secret
                        </label>
                        <div className="flex items-center gap-1.5">
                            <code className="flex-1 text-[11px] font-mono bg-muted/40 px-2 py-1 rounded border border-border/30 truncate select-all">
                                {webhook.secret}
                            </code>
                            <CopyButton text={webhook.secret} label="Copy secret" />
                        </div>
                    </div>

                    {/* Curl snippet */}
                    <div className="space-y-1">
                        <div className="flex items-center justify-between">
                            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                                Example curl
                            </label>
                            <CopyButton text={curlSnippet} label="Copy curl command" />
                        </div>
                        <pre className="text-[10px] font-mono bg-muted/40 px-2 py-1.5 rounded border border-border/30 overflow-x-auto whitespace-pre text-muted-foreground leading-relaxed">
                            {curlSnippet}
                        </pre>
                    </div>

                    {/* Webhook ID */}
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50">
                        <span className="font-mono">id: {webhook.id}</span>
                        <span>·</span>
                        <span>created {new Date(webhook.createdAt).toLocaleDateString()}</span>
                    </div>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Recent-folder picker constants
// ---------------------------------------------------------------------------

const FOLDER_ROW_HEIGHT = 36;
const FOLDER_OVERSCAN = 8;
const FOLDER_LIST_MAX_HEIGHT = 200;

// ---------------------------------------------------------------------------
// CreateWebhookForm
// ---------------------------------------------------------------------------

function CreateWebhookForm({
    runnerId,
    onCreated,
}: {
    runnerId?: string | null;
    onCreated: (webhook: WebhookData) => void;
}) {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [source, setSource] = useState("custom");
    const [cwd, setCwd] = useState("");
    const [prompt, setPrompt] = useState("");
    const [eventFilter, setEventFilter] = useState("");
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // ── Recent folders ──────────────────────────────────────────────────
    const [recentFolders, setRecentFolders] = useState<string[]>([]);
    const [recentFoldersLoading, setRecentFoldersLoading] = useState(false);

    useEffect(() => {
        if (!open || !runnerId) return;
        let cancelled = false;
        setRecentFoldersLoading(true);
        fetch(`/api/runners/${encodeURIComponent(runnerId)}/recent-folders`, {
            credentials: "include",
        })
            .then((res) => {
                if (!res.ok) throw new Error();
                return res.json();
            })
            .then((body: any) => {
                if (!cancelled) {
                    setRecentFolders(Array.isArray(body?.folders) ? body.folders : []);
                }
            })
            .catch(() => { /* silent */ })
            .finally(() => { if (!cancelled) setRecentFoldersLoading(false); });
        return () => { cancelled = true; };
    }, [open, runnerId]);

    const filteredFolders = useMemo(
        () => filterFolders(recentFolders, cwd),
        [recentFolders, cwd],
    );

    const folderListRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: filteredFolders.length,
        getScrollElement: () => folderListRef.current,
        estimateSize: () => FOLDER_ROW_HEIGHT,
        overscan: FOLDER_OVERSCAN,
    });

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;

        setCreating(true);
        setError(null);
        try {
            const input: Parameters<typeof createWebhookApi>[0] = {
                name: name.trim(),
                source: source.trim() || "custom",
            };
            if (runnerId) input.runnerId = runnerId;
            if (cwd.trim()) input.cwd = cwd.trim();
            if (prompt.trim()) input.prompt = prompt.trim();
            const filterItems = eventFilter
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            if (filterItems.length > 0) input.eventFilter = filterItems;

            const webhook = await createWebhookApi(input);
            onCreated(webhook);

            // Reset form
            setName("");
            setSource("custom");
            setCwd("");
            setPrompt("");
            setEventFilter("");
            setOpen(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create webhook");
        } finally {
            setCreating(false);
        }
    };

    if (!open) {
        return (
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                New Webhook
            </Button>
        );
    }

    return (
        <form
            onSubmit={handleSubmit}
            className="rounded-lg border border-border/40 bg-muted/10 p-3 space-y-3"
        >
            <div className="flex items-center gap-2">
                <WebhookIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium">New Webhook</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                        Name *
                    </label>
                    <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. Deploy Notifications"
                        className="h-8 text-xs"
                        required
                        autoFocus
                    />
                </div>
                <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                        Source
                    </label>
                    <Input
                        value={source}
                        onChange={(e) => setSource(e.target.value)}
                        placeholder="custom"
                        className="h-8 text-xs"
                    />
                </div>
            </div>

            {/* Project / cwd */}
            <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Project{" "}
                    <span className="font-normal normal-case">(working directory for new sessions)</span>
                </label>
                <Input
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                    placeholder="/path/to/project"
                    className="h-8 text-xs font-mono"
                />

                {/* Recent folders list */}
                {recentFoldersLoading && (
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        Loading recent projects…
                    </div>
                )}
                {!recentFoldersLoading && recentFolders.length > 0 && (
                    <div className="flex flex-col gap-1">
                        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                            Recent projects
                            {cwd.trim() && filteredFolders.length !== recentFolders.length && (
                                <span className="normal-case tracking-normal ml-1 font-normal">
                                    ({filteredFolders.length} of {recentFolders.length})
                                </span>
                            )}
                        </p>
                        <div
                            ref={folderListRef}
                            style={{ maxHeight: FOLDER_LIST_MAX_HEIGHT, overflowY: "auto" }}
                            className="rounded-md border border-border"
                        >
                            {filteredFolders.length === 0 ? (
                                <p className="px-3 py-2 text-[10px] text-muted-foreground">
                                    No matches for &ldquo;{cwd}&rdquo;.
                                </p>
                            ) : (
                                <div
                                    style={{
                                        height: virtualizer.getTotalSize(),
                                        position: "relative",
                                    }}
                                >
                                    {virtualizer.getVirtualItems().map((item) => {
                                        const folder = filteredFolders[item.index];
                                        const basename =
                                            folder.split("/").filter(Boolean).pop() || folder;
                                        const tail = formatPathTail(folder, 2);
                                        const isSelected = cwd === folder;
                                        return (
                                            <button
                                                key={folder}
                                                type="button"
                                                onClick={() => setCwd(folder)}
                                                title={folder}
                                                style={{
                                                    position: "absolute",
                                                    top: item.start,
                                                    left: 0,
                                                    right: 0,
                                                    height: FOLDER_ROW_HEIGHT,
                                                }}
                                                className={cn(
                                                    "flex items-center gap-2 px-2 text-left w-full",
                                                    isSelected
                                                        ? "bg-accent text-accent-foreground"
                                                        : "hover:bg-muted",
                                                )}
                                            >
                                                <FolderOpen className="h-3 w-3 flex-shrink-0 opacity-60" />
                                                <span className="text-xs font-mono truncate">
                                                    {basename}
                                                </span>
                                                {tail !== basename && (
                                                    <span className="text-[10px] text-muted-foreground font-mono truncate">
                                                        {tail}
                                                    </span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Prompt */}
            <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Prompt{" "}
                    <span className="font-normal normal-case">(initial instructions for the session)</span>
                </label>
                <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="e.g. You received a webhook event. Process the trigger payload and take appropriate action."
                    rows={3}
                    className={cn(
                        "w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none",
                        "placeholder:text-muted-foreground dark:bg-input/30 border-input",
                        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                        "resize-y",
                    )}
                />
            </div>

            {/* Event filter */}
            <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Event Filter{" "}
                    <span className="font-normal normal-case">(comma-separated, optional)</span>
                </label>
                <Input
                    value={eventFilter}
                    onChange={(e) => setEventFilter(e.target.value)}
                    placeholder="e.g. deploy, build"
                    className="h-8 text-xs"
                />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={creating || !name.trim()}>
                    {creating ? (
                        <>
                            <Spinner className="h-3.5 w-3.5 mr-1" />
                            Creating…
                        </>
                    ) : (
                        "Create"
                    )}
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setOpen(false)}
                    disabled={creating}
                >
                    Cancel
                </Button>
            </div>
        </form>
    );
}

// ---------------------------------------------------------------------------
// WebhooksManager
// ---------------------------------------------------------------------------

export function WebhooksManager({ bare, runnerId }: { bare?: boolean; runnerId?: string | null }) {
    const [webhooks, setWebhooks] = useState<WebhookData[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [togglingId, setTogglingId] = useState<string | null>(null);
    const [newSecret, setNewSecret] = useState<string | null>(null);

    const loadWebhooks = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const list = await fetchWebhooks();
            setWebhooks(list);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load webhooks");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadWebhooks();
    }, [loadWebhooks]);

    const handleCreated = (webhook: WebhookData) => {
        setWebhooks((prev) => [webhook, ...prev]);
        setNewSecret(webhook.secret);
    };

    const handleToggle = async (id: string, enabled: boolean) => {
        setTogglingId(id);
        try {
            const updated = await updateWebhookApi(id, { enabled });
            setWebhooks((prev) => prev.map((w) => (w.id === id ? updated : w)));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update webhook");
        } finally {
            setTogglingId(null);
        }
    };

    const handleDelete = async (id: string) => {
        setDeletingId(id);
        try {
            await deleteWebhookApi(id);
            setWebhooks((prev) => prev.filter((w) => w.id !== id));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to delete webhook");
        } finally {
            setDeletingId(null);
        }
    };

    // Auto-dismiss errors
    useEffect(() => {
        if (!error) return;
        const timer = setTimeout(() => setError(null), 5000);
        return () => clearTimeout(timer);
    }, [error]);

    const content = (
        <div className="flex flex-col gap-4">
            {/* New secret banner */}
            {newSecret && (
                <RevealedSecretBanner
                    value={newSecret}
                    onDismiss={() => setNewSecret(null)}
                />
            )}

            {/* Create form */}
            <CreateWebhookForm runnerId={runnerId} onCreated={handleCreated} />

            {/* Error */}
            {error && <p className="text-sm text-destructive">{error}</p>}

            {/* List */}
            {loading ? (
                <div className="flex items-center justify-center py-8">
                    <Spinner className="h-5 w-5 text-muted-foreground" />
                </div>
            ) : webhooks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
                    <div className="rounded-full bg-muted p-3">
                        <WebhookIcon className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="space-y-1">
                        <p className="text-sm font-medium text-muted-foreground">
                            No webhooks yet
                        </p>
                        <p className="text-xs text-muted-foreground/60 max-w-xs">
                            Create a webhook to receive external events. Each fire spawns a
                            fresh session on your runner and delivers the payload as a trigger.
                        </p>
                    </div>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {webhooks.map((wh) => (
                        <WebhookRow
                            key={wh.id}
                            webhook={wh}
                            onToggle={(enabled) => handleToggle(wh.id, enabled)}
                            onDelete={() => handleDelete(wh.id)}
                            isDeleting={deletingId === wh.id}
                            isToggling={togglingId === wh.id}
                        />
                    ))}
                </div>
            )}
        </div>
    );

    if (bare) return content;

    return (
        <Card className="w-full">
            <CardHeader>
                <div className="flex items-center gap-2">
                    <WebhookIcon className="h-5 w-5 text-muted-foreground" />
                    <CardTitle>Webhooks</CardTitle>
                </div>
                <CardDescription>
                    Receive external events as triggers in fresh agent sessions.
                    Each fire spawns a new session and delivers the HMAC-signed payload.
                </CardDescription>
            </CardHeader>
            <CardContent>{content}</CardContent>
        </Card>
    );
}
