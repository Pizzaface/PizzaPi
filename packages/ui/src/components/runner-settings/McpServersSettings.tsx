import { useState } from "react";
import { Plus, Save, Server, ChevronDown, Trash2, Globe, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { SectionProps } from "./RunnerSettingsPanel";

interface McpServerEntry {
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    cwd?: string;
    disabled?: boolean;
}

type ServersMap = Record<string, McpServerEntry>;

function parseServers(config: Record<string, any>): ServersMap {
    const raw = config.mcpServers;
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
    return { ...raw } as ServersMap;
}

export default function McpServersSettings({ config, onSave, saving }: SectionProps) {
    const [servers, setServers] = useState<ServersMap>(() => parseServers(config));
    const [expandedServer, setExpandedServer] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

    // New server form
    const [showAdd, setShowAdd] = useState(false);
    const [newName, setNewName] = useState("");
    const [newType, setNewType] = useState<"stdio" | "http">("stdio");
    const [newCommand, setNewCommand] = useState("");
    const [newArgs, setNewArgs] = useState("");
    const [newUrl, setNewUrl] = useState("");

    const serverNames = Object.keys(servers).sort((a, b) => a.localeCompare(b));

    function updateServer(name: string, patch: Partial<McpServerEntry>) {
        setServers((prev) => ({
            ...prev,
            [name]: { ...prev[name], ...patch },
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
        }

        setServers((prev) => ({ ...prev, [name]: entry }));
        setNewName("");
        setNewCommand("");
        setNewArgs("");
        setNewUrl("");
        setShowAdd(false);
        setExpandedServer(name);
    }

    async function handleSave() {
        await onSave("mcpServers", servers);
    }

    const isStdio = (s: McpServerEntry) => !!s.command || !!s.args;

    return (
        <div className="flex flex-col gap-6">
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
                >
                    <Plus className="h-3.5 w-3.5" />
                    Add Server
                </Button>
            </div>

            {/* Add new server form */}
            {showAdd && (
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
                            <p className="text-xs text-destructive">A server with this name already exists.</p>
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
            {serverNames.length === 0 && !showAdd && (
                <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
                    <Server className="h-8 w-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
                    <p className="text-xs text-muted-foreground">
                        Add a server to extend the agent with additional tools.
                    </p>
                </div>
            )}

            {serverNames.map((name) => {
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
                                            <span className="text-sm font-semibold truncate">{name}</span>
                                            {server.disabled && (
                                                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                                    disabled
                                                </Badge>
                                            )}
                                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
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
                                        <Label htmlFor={`mcp-disabled-${name}`} className="text-xs">
                                            Enabled
                                        </Label>
                                        <Switch
                                            id={`mcp-disabled-${name}`}
                                            checked={!server.disabled}
                                            onCheckedChange={() => toggleDisabled(name)}
                                        />
                                    </div>

                                    {serverIsStdio ? (
                                        <>
                                            {/* Command */}
                                            <div className="flex flex-col gap-1.5">
                                                <Label className="text-xs">Command</Label>
                                                <Input
                                                    value={server.command ?? ""}
                                                    onChange={(e) =>
                                                        updateServer(name, { command: e.target.value })
                                                    }
                                                    className="font-mono text-sm"
                                                    placeholder="npx"
                                                />
                                            </div>

                                            {/* Args */}
                                            <div className="flex flex-col gap-1.5">
                                                <Label className="text-xs">Args (comma-separated)</Label>
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
                                        /* URL */
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
                                            <span className="text-muted-foreground">(KEY=VALUE, one per line)</span>
                                        </Label>
                                        <textarea
                                            value={envToText(server.env)}
                                            onChange={(e) =>
                                                updateServer(name, { env: textToEnv(e.target.value) })
                                            }
                                            rows={Math.max(2, Object.keys(server.env ?? {}).length + 1)}
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
                                                <span className="text-xs text-destructive">Delete this server?</span>
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

            {/* Footer */}
            <div className="flex items-center justify-between pt-2">
                <p className="text-xs text-muted-foreground italic">
                    Changes apply on next runner restart.
                </p>
                <Button onClick={handleSave} disabled={saving} size="sm" className="gap-1.5">
                    <Save className="h-3.5 w-3.5" />
                    {saving ? "Saving…" : "Save"}
                </Button>
            </div>
        </div>
    );
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

/** Parse a comma-separated string into a trimmed args array. */
function parseArgs(input: string): string[] {
    return input
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Convert env record to "KEY=VALUE\n" text. */
function envToText(env?: Record<string, string>): string {
    if (!env) return "";
    return Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
}

/** Parse "KEY=VALUE\n" text back into an env record. */
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
