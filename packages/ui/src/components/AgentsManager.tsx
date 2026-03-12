import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Bot,
    Loader2,
    Plus,
    Pencil,
    Trash2,
    ChevronDown,
    Wand2,
    RefreshCw,
} from "lucide-react";
import { ErrorAlert } from "@/components/ui/error-alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentInfo {
    name: string;
    description: string;
    filePath: string;
}

export interface AgentsManagerProps {
    runnerId: string;
    /** Initial agent list (already fetched by parent) */
    agents: AgentInfo[];
    /** Called when agents change so the parent can update its state */
    onAgentsChange?: (agents: AgentInfo[]) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildDefaultAgentContent(name: string, description: string): string {
    return `---
name: ${name}
description: ${description || `A custom agent named ${name}.`}
tools: read,bash,edit,write
---

# ${name}

You are a specialized agent. Describe your role and behavior here.

## Guidelines

- What this agent is responsible for
- How it should approach tasks
- What tools it should use
- What output format to follow
`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface AgentRowProps {
    agent: AgentInfo;
    onEdit: (agent: AgentInfo) => void;
    onDelete: (agent: AgentInfo) => void;
    deleting: boolean;
}

function AgentRow({ agent, onEdit, onDelete, deleting }: AgentRowProps) {
    return (
        <div className="flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg border border-border/40 bg-muted/20 hover:bg-muted/40 transition-colors group">
            <div className="flex items-start gap-2.5 min-w-0">
                <Bot className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-primary/60" />
                <div className="min-w-0">
                    <p className="text-xs font-semibold font-mono truncate text-foreground">{agent.name}</p>
                    {agent.description && (
                        <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{agent.description}</p>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                    onClick={() => onEdit(agent)}
                    title="Edit agent"
                >
                    <Pencil className="h-3 w-3" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(agent)}
                    disabled={deleting}
                    title="Delete agent"
                >
                    {deleting ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                        <Trash2 className="h-3 w-3" />
                    )}
                </Button>
            </div>
        </div>
    );
}

// ── Agent editor dialog ───────────────────────────────────────────────────────

interface AgentEditorDialogProps {
    runnerId: string;
    open: boolean;
    /** null = creating new, AgentInfo = editing existing */
    agent: AgentInfo | null;
    onClose: () => void;
    onSaved: (updatedAgents: AgentInfo[]) => void;
}

function AgentEditorDialog({ runnerId, open, agent, onClose, onSaved }: AgentEditorDialogProps) {
    const isEditing = agent !== null;

    const [name, setName] = React.useState("");
    const [content, setContent] = React.useState("");
    const [saving, setSaving] = React.useState(false);
    const [loadingContent, setLoadingContent] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    // When dialog opens, populate fields
    React.useEffect(() => {
        if (!open) return;

        if (!isEditing) {
            setName("");
            setContent("");
            setError(null);
            return;
        }

        // Load existing content from the runner
        setLoadingContent(true);
        setError(null);
        setName(agent.name);
        setContent("");

        fetch(`/api/runners/${encodeURIComponent(runnerId)}/agents/${encodeURIComponent(agent.name)}`, {
            credentials: "include",
        })
            .then((res) => (res.ok ? res.json() : res.json().then((b: any) => Promise.reject(new Error(b?.error ?? `HTTP ${res.status}`)))))
            .then((data: any) => {
                setContent(typeof data.content === "string" ? data.content : "");
            })
            .catch((err: Error) => {
                setError(err.message);
            })
            .finally(() => setLoadingContent(false));
    }, [open, isEditing, agent, runnerId]);

    const handleGenerateTemplate = () => {
        const descMatch = content.match(/^description:\s*(.+)$/m);
        const desc = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : "";
        setContent(buildDefaultAgentContent(name || "my-agent", desc));
    };

    const handleSave = async () => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            setError("Agent name is required");
            return;
        }

        // Validate name — strict for new agents, relaxed for edits (discovered
        // agents may have uppercase, underscores, or dots in their names)
        if (isEditing) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmedName)) {
                setError("Invalid agent name");
                return;
            }
        } else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmedName)) {
            setError("Name must contain only lowercase letters, numbers, and hyphens");
            return;
        }

        setSaving(true);
        setError(null);

        try {
            const url = isEditing
                ? `/api/runners/${encodeURIComponent(runnerId)}/agents/${encodeURIComponent(trimmedName)}`
                : `/api/runners/${encodeURIComponent(runnerId)}/agents`;

            const method = isEditing ? "PUT" : "POST";
            const body = isEditing
                ? JSON.stringify({ content })
                : JSON.stringify({ name: trimmedName, content });

            const res = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body,
                credentials: "include",
            });

            const data = await res.json().catch(() => null) as any;
            if (!res.ok) {
                setError(data?.error ?? `Failed to save agent (HTTP ${res.status})`);
                return;
            }

            onSaved(Array.isArray(data?.agents) ? data.agents : []);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle>{isEditing ? `Edit agent: ${agent?.name}` : "New Agent"}</DialogTitle>
                    <DialogDescription>
                        {isEditing
                            ? "Edit the agent definition markdown file."
                            : "Create a new agent definition in ~/.pizzapi/agents/."}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto py-1">
                    {/* Name (only editable when creating) */}
                    {!isEditing && (
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="agent-name" className="text-sm">
                                Agent name
                                <span className="ml-1 text-muted-foreground font-normal">(lowercase, hyphens)</span>
                            </Label>
                            <Input
                                id="agent-name"
                                placeholder="my-agent"
                                value={name}
                                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                                className="font-mono text-sm"
                                disabled={saving}
                            />
                        </div>
                    )}

                    {/* Agent markdown content */}
                    <div className="flex flex-col gap-1.5 flex-1 min-h-0">
                        <div className="flex items-center justify-between">
                            <Label htmlFor="agent-content" className="text-sm">
                                Agent definition
                            </Label>
                            {!isEditing && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                                    onClick={handleGenerateTemplate}
                                    disabled={saving}
                                >
                                    <Wand2 className="h-3 w-3 mr-1" />
                                    Generate template
                                </Button>
                            )}
                        </div>

                        {loadingContent ? (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Loading agent content…
                            </div>
                        ) : (
                            <textarea
                                id="agent-content"
                                className={cn(
                                    "flex-1 min-h-[280px] w-full rounded-md border border-input bg-background px-3 py-2",
                                    "font-mono text-xs resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                                    "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
                                )}
                                placeholder={`---\nname: my-agent\ndescription: What this agent does.\ntools: read,bash,edit,write\n---\n\n# My Agent\n\nDescribe the agent's role and behavior here.\n`}
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                disabled={saving}
                                spellCheck={false}
                            />
                        )}
                    </div>

                    {error && <ErrorAlert>{error}</ErrorAlert>}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={saving || loadingContent}>
                        {saving ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Saving…
                            </>
                        ) : (
                            <>
                                <Bot className="mr-2 h-4 w-4" />
                                {isEditing ? "Save Changes" : "Create Agent"}
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ── Delete confirmation dialog ────────────────────────────────────────────────

interface DeleteAgentDialogProps {
    runnerId: string;
    agent: AgentInfo | null;
    onClose: () => void;
    onDeleted: (updatedAgents: AgentInfo[]) => void;
}

function DeleteAgentDialog({ runnerId, agent, onClose, onDeleted }: DeleteAgentDialogProps) {
    const [deleting, setDeleting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const handleDelete = async () => {
        if (!agent) return;
        setDeleting(true);
        setError(null);

        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/agents/${encodeURIComponent(agent.name)}`, {
                method: "DELETE",
                credentials: "include",
            });
            const data = await res.json().catch(() => null) as any;
            if (!res.ok) {
                setError(data?.error ?? `Failed to delete agent (HTTP ${res.status})`);
                return;
            }
            onDeleted(Array.isArray(data?.agents) ? data.agents : []);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setDeleting(false);
        }
    };

    return (
        <Dialog open={agent !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>Delete agent</DialogTitle>
                    <DialogDescription>
                        Are you sure you want to delete{" "}
                        <span className="font-mono font-semibold text-foreground">{agent?.name}</span>?
                        This will remove the agent definition from the runner.
                    </DialogDescription>
                </DialogHeader>

                {error && <ErrorAlert>{error}</ErrorAlert>}

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={deleting}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                        {deleting ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Deleting…
                            </>
                        ) : (
                            <>
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ── Main component ────────────────────────────────────────────────────────────

export function AgentsManager({ runnerId, agents: initialAgents, onAgentsChange }: AgentsManagerProps) {
    const [agents, setAgents] = React.useState<AgentInfo[]>(initialAgents);
    const [open, setOpen] = React.useState(false);
    const [refreshing, setRefreshing] = React.useState(false);

    // Editor dialog state
    const [editorOpen, setEditorOpen] = React.useState(false);
    const [editingAgent, setEditingAgent] = React.useState<AgentInfo | null>(null);

    // Delete dialog state
    const [deletingAgent, setDeletingAgent] = React.useState<AgentInfo | null>(null);
    const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);

    // Keep in sync with parent
    React.useEffect(() => {
        setAgents(initialAgents);
    }, [initialAgents]);

    const handleAgentsChange = (updated: AgentInfo[]) => {
        setAgents(updated);
        onAgentsChange?.(updated);
    };

    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/agents/refresh`, {
                method: "POST",
                credentials: "include",
            });
            const data = await res.json().catch(() => null) as any;
            if (res.ok && Array.isArray(data?.agents)) {
                handleAgentsChange(data.agents);
            }
        } catch (err) {
            console.error("Failed to refresh agents:", err);
        } finally {
            setRefreshing(false);
        }
    };

    const handleEdit = (agent: AgentInfo) => {
        setEditingAgent(agent);
        setEditorOpen(true);
    };

    const handleDeleteRequest = (agent: AgentInfo) => {
        setPendingDelete(agent.name);
        setDeletingAgent(agent);
    };

    const handleNewAgent = () => {
        setEditingAgent(null);
        setEditorOpen(true);
    };

    return (
        <>
            <Collapsible open={open} onOpenChange={setOpen}>
                <div className="flex items-center justify-between mt-3">
                    <CollapsibleTrigger className="flex items-center gap-1.5 text-left group/trigger">
                        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                            Agents
                        </span>
                        <Badge
                            variant="secondary"
                            className="h-4 px-1.5 text-[10px] font-mono rounded-sm"
                        >
                            {agents.length}
                        </Badge>
                        <ChevronDown
                            className={cn(
                                "h-3 w-3 text-muted-foreground/60 transition-transform duration-200",
                                open && "rotate-180"
                            )}
                        />
                    </CollapsibleTrigger>

                    <div className="flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                            onClick={handleRefresh}
                            disabled={refreshing}
                            title="Re-scan agents from disk"
                        >
                            <RefreshCw className={cn("h-3 w-3 mr-1", refreshing && "animate-spin")} />
                            Reload
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                            onClick={handleNewAgent}
                        >
                            <Plus className="h-3 w-3 mr-1" />
                            New agent
                        </Button>
                    </div>
                </div>

                <CollapsibleContent>
                    <div className="mt-2 flex flex-col gap-1.5">
                        {agents.length === 0 ? (
                            <div className="flex flex-col items-center gap-2 py-5 text-center">
                                <Bot className="h-5 w-5 text-muted-foreground/40" />
                                <div className="space-y-0.5">
                                    <p className="text-xs font-medium text-muted-foreground">No agents yet</p>
                                    <p className="text-[11px] text-muted-foreground/60 max-w-[200px]">
                                        Add an agent .md file to{" "}
                                        <span className="font-mono">~/.pizzapi/agents/</span>{" "}
                                        or click &ldquo;New agent&rdquo; above.
                                    </p>
                                </div>
                            </div>
                        ) : (
                            agents.map((agent) => (
                                <AgentRow
                                    key={agent.name}
                                    agent={agent}
                                    onEdit={handleEdit}
                                    onDelete={handleDeleteRequest}
                                    deleting={pendingDelete === agent.name}
                                />
                            ))
                        )}
                    </div>
                </CollapsibleContent>
            </Collapsible>

            <AgentEditorDialog
                runnerId={runnerId}
                open={editorOpen}
                agent={editingAgent}
                onClose={() => { setEditorOpen(false); setEditingAgent(null); }}
                onSaved={(updated) => { handleAgentsChange(updated); }}
            />

            <DeleteAgentDialog
                runnerId={runnerId}
                agent={deletingAgent}
                onClose={() => { setDeletingAgent(null); setPendingDelete(null); }}
                onDeleted={(updated) => { handleAgentsChange(updated); setPendingDelete(null); }}
            />
        </>
    );
}
