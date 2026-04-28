/**
 * McpServersManager — standalone MCP server config editor.
 *
 * Self-contained: fetches config from the runner settings API and saves back.
 * Validates server entries and shows reload hints after save.
 */
import { useState, useEffect, useCallback } from "react";
import {
    Plus,
    Save,
    Server,
    ChevronDown,
    Trash2,
    Globe,
    Terminal,
    CheckCircle,
    Loader2,
    RotateCcw,
    RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ErrorAlert } from "@/components/ui/error-alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { applyDeferLoadingMode, deferLoadingValueToMode, type DeferLoadingMode } from "@/components/mcp-server-defer-loading";
import { formatMcpReloadMessage } from "@/components/mcp-reload-status";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpServersManagerProps {
    runnerId: string;
    bare?: boolean;
}

interface McpServerEntry {
    command?: string;
    args?: string[];
    url?: string;
    type?: string;
    transport?: string;
    env?: Record<string, string>;
    cwd?: string;
    disabled?: boolean;
    deferLoading?: boolean;
}

type ServersMap = Record<string, McpServerEntry>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs(input: string): string[] {
    return input
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function envToText(env?: Record<string, string>): string {
    if (!env) return "";
    return Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
}

function textToEnv(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1);
        if (key) result[key] = value;
    }
    return result;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function McpServersManager({ runnerId, bare }: McpServersManagerProps) {
    // Data
    const [servers, setServers] = useState<ServersMap>({});
    const [savedServers, setSavedServers] = useState<ServersMap>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saveMessage, setSaveMessage] = useState<string | null>(null);
    const [reloading, setReloading] = useState(false);
    const [reloadMessage, setReloadMessage] = useState<string | null>(null);
    const [hasPreferredFormatConfig, setHasPreferredFormatConfig] = useState(false);

    // Expand/delete state
    const [expandedServer, setExpandedServer] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

    // New server form
    const [showAdd, setShowAdd] = useState(false);
    const [newName, setNewName] = useState("");
    const [newType, setNewType] = useState<"stdio" | "http">("stdio");
    const [newCommand, setNewCommand] = useState("");
    const [newArgs, setNewArgs] = useState("");
    const [newUrl, setNewUrl] = useState("");

    // ── Fetch ─────────────────────────────────────────────────────────────────

    const fetchConfig = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/settings`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            const result = await res.json();
            const cfg = result.config ?? {};
            const raw = cfg.mcpServers;
            const parsed: ServersMap =
                raw != null && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
            const preferredServers = Array.isArray(cfg.mcp?.servers) ? cfg.mcp.servers : [];
            setHasPreferredFormatConfig(preferredServers.length > 0);
            setServers(parsed);
            setSavedServers(parsed);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [runnerId]);

    useEffect(() => {
        fetchConfig();
    }, [fetchConfig]);

    // ── Save ──────────────────────────────────────────────────────────────────

    const handleSave = async () => {
        setSaving(true);
        setSaveMessage(null);
        setReloadMessage(null);
        setError(null);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/settings`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ section: "mcpServers", value: servers }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            setSavedServers({ ...servers });
            setSaveMessage(
                "MCP server config saved. Reload MCP in active sessions to apply changes immediately.",
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    };

    // ── Editing helpers ───────────────────────────────────────────────────────

    const serverNames = Object.keys(servers).sort((a, b) => a.localeCompare(b));
    const isStdio = (s: McpServerEntry) => !!s.command || !!s.args;

    function updateServer(name: string, patch: Partial<McpServerEntry>) {
        setServers((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));
    }

    function updateDeferLoading(name: string, mode: DeferLoadingMode) {
        setServers((prev) => ({
            ...prev,
            [name]: applyDeferLoadingMode(prev[name] ?? {}, mode),
        }));
    }

    function toggleDisabled(name: string) {
        updateServer(name, { disabled: !servers[name]?.disabled });
    }

    function deleteServer(name: string) {
        setServers((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
        });
        setConfirmDelete(null);
        if (expandedServer === name) setExpandedServer(null);
    }

    function addServer() {
        const name = newName.trim();
        if (!name || servers[name]) return;
        const entry: McpServerEntry = {};
        if (newType === "stdio") {
            entry.command = newCommand.trim();
            entry.args = parseArgs(newArgs);
        } else {
            entry.url = newUrl.trim();
            entry.type = "http";
        }
        setServers((prev) => ({ ...prev, [name]: entry }));
        setNewName("");
        setNewCommand("");
        setNewArgs("");
        setNewUrl("");
        setShowAdd(false);
        setExpandedServer(name);
    }

    async function reloadActiveSessions() {
        setReloadMessage(null);
        setError(null);
        setReloading(true);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/mcp/reload`, {
                method: "POST",
                credentials: "include",
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            const body = await res.json() as { reloaded: number; failed: number };
            setReloadMessage(formatMcpReloadMessage(body));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setReloading(false);
        }
    }

    // ── Loading / error ───────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="flex items-center justify-center p-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Loading MCP servers…</span>
            </div>
        );
    }

    if (error && Object.keys(servers).length === 0 && Object.keys(savedServers).length === 0) {
        return (
            <div className="p-4">
                <ErrorAlert>{error}</ErrorAlert>
                <Button variant="outline" size="sm" className="mt-3" onClick={fetchConfig}>
                    <RotateCcw className="h-3.5 w-3.5 mr-1" />
                    Retry
                </Button>
            </div>
        );
    }

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className={cn("flex flex-col gap-6", !bare && "p-4")}>
            {/* Error banner */}
            {error && (
                <div className="flex items-center justify-between">
                    <ErrorAlert className="flex-1">{error}</ErrorAlert>
                    <button
                        type="button"
                        onClick={() => setError(null)}
                        className="ml-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                        ✕
                    </button>
                </div>
            )}

            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Server className="h-5 w-5 text-muted-foreground" />
                    <h3 className="text-sm font-medium">MCP Servers</h3>
                    <Badge variant="secondary" className="text-xs">
                        {serverNames.length}
                    </Badge>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setShowAdd(!showAdd)}
                    disabled={hasPreferredFormatConfig}
                >
                    <Plus className="h-3.5 w-3.5" />
                    Add Server
                </Button>
            </div>

            {hasPreferredFormatConfig && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
                    This runner is configured with the <code>mcp.servers[]</code> format. The web MCP editor currently supports only <code>mcpServers</code>, so editing is disabled here to avoid writing a conflicting config shape.
                </div>
            )}

            {/* Add new server form */}
            {!hasPreferredFormatConfig && showAdd && (
                <div className="rounded-md border border-border bg-card p-4 flex flex-col gap-3">
                    <p className="text-sm font-medium">New MCP Server</p>

                    <div className="flex flex-col gap-2">
                        <Label htmlFor="mcp-new-name" className="text-xs">
                            Server Name
                        </Label>
                        <Input
                            id="mcp-new-name"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            placeholder="my-server"
                            className="font-mono text-sm"
                        />
                        {newName.trim() && servers[newName.trim()] && (
                            <p className="text-xs text-destructive">
                                A server with this name already exists.
                            </p>
                        )}
                    </div>

                    {/* Type toggle */}
                    <div className="flex gap-2">
                        <Button
                            variant={newType === "stdio" ? "default" : "outline"}
                            size="sm"
                            onClick={() => setNewType("stdio")}
                            className="gap-1.5"
                        >
                            <Terminal className="h-3.5 w-3.5" />
                            stdio
                        </Button>
                        <Button
                            variant={newType === "http" ? "default" : "outline"}
                            size="sm"
                            onClick={() => setNewType("http")}
                            className="gap-1.5"
                        >
                            <Globe className="h-3.5 w-3.5" />
                            Streamable HTTP
                        </Button>
                    </div>

                    {newType === "stdio" ? (
                        <>
                            <div className="flex flex-col gap-2">
                                <Label htmlFor="mcp-new-cmd" className="text-xs">
                                    Command
                                </Label>
                                <Input
                                    id="mcp-new-cmd"
                                    value={newCommand}
                                    onChange={(e) => setNewCommand(e.target.value)}
                                    placeholder="npx"
                                    className="font-mono text-sm"
                                />
                            </div>
                            <div className="flex flex-col gap-2">
                                <Label htmlFor="mcp-new-args" className="text-xs">
                                    Args (comma-separated)
                                </Label>
                                <Input
                                    id="mcp-new-args"
                                    value={newArgs}
                                    onChange={(e) => setNewArgs(e.target.value)}
                                    placeholder="-y, @some/mcp-server"
                                    className="font-mono text-sm"
                                />
                            </div>
                        </>
                    ) : (
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="mcp-new-url" className="text-xs">
                                URL
                            </Label>
                            <Input
                                id="mcp-new-url"
                                value={newUrl}
                                onChange={(e) => setNewUrl(e.target.value)}
                                placeholder="http://localhost:3001/mcp"
                                className="font-mono text-sm"
                            />
                        </div>
                    )}

                    <div className="flex gap-2 justify-end">
                        <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            onClick={addServer}
                            disabled={
                                !newName.trim() ||
                                !!servers[newName.trim()] ||
                                (newType === "stdio" ? !newCommand.trim() : !newUrl.trim())
                            }
                        >
                            Add
                        </Button>
                    </div>
                </div>
            )}

            {/* Server list */}
            {!hasPreferredFormatConfig && serverNames.length === 0 && !showAdd && (
                <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
                    <Server className="h-8 w-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
                    <p className="text-xs text-muted-foreground">
                        Add a server to extend the agent with additional tools.
                    </p>
                </div>
            )}

            {!hasPreferredFormatConfig && serverNames.map((name) => {
                const server = servers[name];
                const expanded = expandedServer === name;
                const serverIsStdio = isStdio(server);
                const summary = serverIsStdio
                    ? [server.command, ...(server.args ?? [])].join(" ")
                    : server.url ?? "";

                return (
                    <Collapsible
                        key={name}
                        open={expanded}
                        onOpenChange={(open) => setExpandedServer(open ? name : null)}
                    >
                        <div
                            className={cn(
                                "rounded-md border border-border bg-card overflow-hidden",
                                server.disabled && "opacity-60",
                            )}
                        >
                            {/* Collapsed header */}
                            <CollapsibleTrigger asChild>
                                <button
                                    type="button"
                                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
                                >
                                    <ChevronDown
                                        className={cn(
                                            "h-4 w-4 text-muted-foreground shrink-0 transition-transform",
                                            expanded && "rotate-180",
                                        )}
                                    />
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-semibold truncate">
                                                {name}
                                            </span>
                                            {server.disabled && (
                                                <Badge
                                                    variant="outline"
                                                    className="text-[10px] px-1.5 py-0"
                                                >
                                                    disabled
                                                </Badge>
                                            )}
                                            <Badge
                                                variant="secondary"
                                                className="text-[10px] px-1.5 py-0"
                                            >
                                                {serverIsStdio ? "stdio" : "http"}
                                            </Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground truncate font-mono mt-0.5">
                                            {summary}
                                        </p>
                                    </div>
                                </button>
                            </CollapsibleTrigger>

                            {/* Expanded content */}
                            <CollapsibleContent>
                                <div className="border-t border-border px-4 py-4 flex flex-col gap-4">
                                    {/* Disabled toggle */}
                                    <div className="flex items-center justify-between">
                                        <Label
                                            htmlFor={`mcp-disabled-${name}`}
                                            className="text-xs"
                                        >
                                            Enabled
                                        </Label>
                                        <Switch
                                            id={`mcp-disabled-${name}`}
                                            checked={!server.disabled}
                                            onCheckedChange={() => toggleDisabled(name)}
                                        />
                                    </div>

                                    {/* Deferred loading override */}
                                    <div className="flex flex-col gap-1.5">
                                        <Label className="text-xs">Deferred Loading</Label>
                                        <Select
                                            value={deferLoadingValueToMode(server.deferLoading)}
                                            onValueChange={(value) => updateDeferLoading(name, value as DeferLoadingMode)}
                                        >
                                            <SelectTrigger className="w-full max-w-xs text-sm">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="inherit">Inherit global behavior</SelectItem>
                                                <SelectItem value="always">Always defer</SelectItem>
                                                <SelectItem value="never">Never defer</SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <p className="text-xs text-muted-foreground">
                                            Overrides Tool Search for this server only.
                                        </p>
                                    </div>

                                    {serverIsStdio ? (
                                        <>
                                            <div className="flex flex-col gap-1.5">
                                                <Label className="text-xs">Command</Label>
                                                <Input
                                                    value={server.command ?? ""}
                                                    onChange={(e) =>
                                                        updateServer(name, {
                                                            command: e.target.value,
                                                        })
                                                    }
                                                    className="font-mono text-sm"
                                                    placeholder="npx"
                                                />
                                            </div>
                                            <div className="flex flex-col gap-1.5">
                                                <Label className="text-xs">
                                                    Args (comma-separated)
                                                </Label>
                                                <Input
                                                    value={(server.args ?? []).join(", ")}
                                                    onChange={(e) =>
                                                        updateServer(name, {
                                                            args: parseArgs(e.target.value),
                                                        })
                                                    }
                                                    className="font-mono text-sm"
                                                    placeholder="-y, @some/mcp-server"
                                                />
                                            </div>
                                        </>
                                    ) : (
                                        <div className="flex flex-col gap-1.5">
                                            <Label className="text-xs">URL</Label>
                                            <Input
                                                value={server.url ?? ""}
                                                onChange={(e) =>
                                                    updateServer(name, { url: e.target.value })
                                                }
                                                className="font-mono text-sm"
                                                placeholder="http://localhost:3001/mcp"
                                            />
                                        </div>
                                    )}

                                    {/* Env vars */}
                                    <div className="flex flex-col gap-1.5">
                                        <Label className="text-xs">
                                            Environment Variables{" "}
                                            <span className="text-muted-foreground">
                                                (KEY=VALUE, one per line)
                                            </span>
                                        </Label>
                                        <textarea
                                            value={envToText(server.env)}
                                            onChange={(e) =>
                                                updateServer(name, {
                                                    env: textToEnv(e.target.value),
                                                })
                                            }
                                            rows={Math.max(
                                                2,
                                                Object.keys(server.env ?? {}).length + 1,
                                            )}
                                            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y"
                                            placeholder={"API_KEY=your-key\nANOTHER_VAR=value"}
                                        />
                                    </div>

                                    {/* CWD */}
                                    <div className="flex flex-col gap-1.5">
                                        <Label className="text-xs">Working Directory</Label>
                                        <Input
                                            value={server.cwd ?? ""}
                                            onChange={(e) =>
                                                updateServer(name, {
                                                    cwd: e.target.value || undefined,
                                                })
                                            }
                                            className="font-mono text-sm"
                                            placeholder="/path/to/dir (optional)"
                                        />
                                    </div>

                                    {/* Delete */}
                                    <div className="flex justify-end pt-1">
                                        {confirmDelete === name ? (
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs text-destructive">
                                                    Delete this server?
                                                </span>
                                                <Button
                                                    variant="destructive"
                                                    size="sm"
                                                    onClick={() => deleteServer(name)}
                                                >
                                                    Confirm
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => setConfirmDelete(null)}
                                                >
                                                    Cancel
                                                </Button>
                                            </div>
                                        ) : (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="text-destructive hover:text-destructive gap-1.5"
                                                onClick={() => setConfirmDelete(name)}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                                Delete
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </CollapsibleContent>
                        </div>
                    </Collapsible>
                );
            })}

            {/* Success message */}
            {!hasPreferredFormatConfig && saveMessage && (
                <div className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/5 px-4 py-3 text-sm text-green-400">
                    <CheckCircle className="mt-0.5 size-4 shrink-0" />
                    <span>{saveMessage}</span>
                </div>
            )}

            {!hasPreferredFormatConfig && reloadMessage && (
                <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-sm text-blue-300">
                    {reloadMessage}
                </div>
            )}

            {/* Footer */}
            {!hasPreferredFormatConfig && (
                <div className="flex items-center justify-between pt-2 gap-3">
                    <p className="text-xs text-muted-foreground italic">
                        Save updates config. Reload MCP applies changes to active sessions now.
                    </p>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" onClick={reloadActiveSessions} disabled={reloading} size="sm" className="gap-1.5">
                            {reloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            Reload MCP
                        </Button>
                        <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
                            <Save className="h-3.5 w-3.5" />
                            {saving ? "Saving…" : "Save"}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
