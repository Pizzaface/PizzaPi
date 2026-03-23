import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Puzzle,
    Loader2,
    ChevronDown,
    RefreshCw,
    Terminal,
    Zap,
    BookOpen,
    Server,
    Bot,
    FileText,
    AlertTriangle,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PluginCommand {
    name: string;
    description?: string;
    argumentHint?: string;
}

export interface PluginInfo {
    name: string;
    description: string;
    rootPath: string;
    commands: PluginCommand[];
    hookEvents: string[];
    skills: { name: string; dirPath: string }[];
    agents?: { name: string }[];
    rules: { name: string }[];
    hasMcp: boolean;
    hasAgents: boolean;
    hasLsp: boolean;
    version?: string;
    author?: string;
}

export interface PluginsManagerProps {
    runnerId: string;
    plugins: PluginInfo[];
    onPluginsChange?: (plugins: PluginInfo[]) => void;
    /** When true, render without Collapsible wrapper (for tab/panel use) */
    bare?: boolean;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PluginCapBadge({ icon: Icon, label, count }: { icon: React.ElementType; label: string; count: number }) {
    if (count === 0) return null;
    return (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
            <Icon className="h-2.5 w-2.5" />
            {count} {label}
        </span>
    );
}

function UnsupportedBadge({ label }: { label: string }) {
    return (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-500/80">
            <AlertTriangle className="h-2.5 w-2.5" />
            {label}
        </span>
    );
}

interface PluginRowProps {
    plugin: PluginInfo;
    onClick: () => void;
}

function PluginRow({ plugin, onClick }: PluginRowProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={`View details for ${plugin.name}`}
            className="flex items-start justify-between gap-3 w-full text-left px-3 py-2.5 rounded-lg border border-border/40 bg-muted/20 hover:bg-muted/40 transition-colors group"
        >
            <div className="flex items-start gap-2.5 min-w-0">
                <Puzzle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-primary/60" />
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <p className="text-xs font-semibold font-mono truncate text-foreground">{plugin.name}</p>
                        {plugin.version && (
                            <Badge variant="outline" className="h-4 px-1 text-[9px] font-mono">
                                v{plugin.version}
                            </Badge>
                        )}
                    </div>
                    {plugin.description && (
                        <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{plugin.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <PluginCapBadge icon={Terminal} label={plugin.commands.length === 1 ? "cmd" : "cmds"} count={plugin.commands.length} />
                        <PluginCapBadge icon={Zap} label={plugin.hookEvents.length === 1 ? "hook" : "hooks"} count={plugin.hookEvents.length} />
                        <PluginCapBadge icon={BookOpen} label={plugin.skills.length === 1 ? "skill" : "skills"} count={plugin.skills.length} />
                        <PluginCapBadge icon={FileText} label={(plugin.rules?.length ?? 0) === 1 ? "rule" : "rules"} count={plugin.rules?.length ?? 0} />
                        <PluginCapBadge icon={Bot} label={(plugin.agents?.length ?? 0) === 1 ? "agent" : "agents"} count={plugin.agents?.length ?? 0} />
                        {plugin.hasMcp && <UnsupportedBadge label="MCP" />}
                    </div>
                </div>
            </div>
        </button>
    );
}

// ── Plugin detail dialog ──────────────────────────────────────────────────────

interface PluginDetailDialogProps {
    plugin: PluginInfo | null;
    onClose: () => void;
}

function PluginDetailDialog({ plugin, onClose }: PluginDetailDialogProps) {
    if (!plugin) return null;

    return (
        <Dialog open={plugin !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Puzzle className="h-4 w-4 text-primary" />
                        {plugin.name}
                        {plugin.version && (
                            <Badge variant="outline" className="text-[10px] font-mono">
                                v{plugin.version}
                            </Badge>
                        )}
                    </DialogTitle>
                    {plugin.description && (
                        <DialogDescription>{plugin.description}</DialogDescription>
                    )}
                </DialogHeader>

                <div className="flex-1 overflow-y-auto space-y-4 py-1">
                    {/* Metadata */}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                        {plugin.author && <span>Author: <span className="text-foreground">{plugin.author}</span></span>}
                        <span className="font-mono text-[10px] truncate max-w-[300px]" title={plugin.rootPath}>
                            {plugin.rootPath}
                        </span>
                    </div>

                    {/* Commands */}
                    {plugin.commands.length > 0 && (
                        <div>
                            <h4 className="text-xs font-medium text-foreground mb-1.5 flex items-center gap-1.5">
                                <Terminal className="h-3 w-3 text-muted-foreground" />
                                Commands
                                <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-mono rounded-sm">
                                    {plugin.commands.length}
                                </Badge>
                            </h4>
                            <div className="space-y-1">
                                {plugin.commands.map((cmd) => (
                                    <div
                                        key={cmd.name}
                                        className="flex items-start gap-2 px-2.5 py-1.5 rounded-md bg-muted/30 border border-border/30"
                                    >
                                        <code className="text-[11px] font-mono text-primary whitespace-nowrap">
                                            /{plugin.name}:{cmd.name}
                                        </code>
                                        {cmd.argumentHint && (
                                            <code className="text-[10px] font-mono text-muted-foreground">
                                                {cmd.argumentHint}
                                            </code>
                                        )}
                                        {cmd.description && (
                                            <span className="text-[11px] text-muted-foreground ml-auto truncate max-w-[200px]">
                                                {cmd.description}
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Hooks */}
                    {plugin.hookEvents.length > 0 && (
                        <div>
                            <h4 className="text-xs font-medium text-foreground mb-1.5 flex items-center gap-1.5">
                                <Zap className="h-3 w-3 text-muted-foreground" />
                                Hooks
                                <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-mono rounded-sm">
                                    {plugin.hookEvents.length}
                                </Badge>
                            </h4>
                            <div className="flex flex-wrap gap-1.5">
                                {plugin.hookEvents.map((event) => {
                                    const piEvent = hookEventMapping[event];
                                    return (
                                        <div
                                            key={event}
                                            className="flex items-center gap-1 px-2 py-1 rounded-md bg-muted/30 border border-border/30"
                                        >
                                            <code className="text-[10px] font-mono text-foreground">{event}</code>
                                            {piEvent ? (
                                                <span className="text-[9px] text-green-500">→ {piEvent}</span>
                                            ) : (
                                                <span className="text-[9px] text-amber-500">⚠ unmapped</span>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Skills */}
                    {plugin.skills.length > 0 && (
                        <div>
                            <h4 className="text-xs font-medium text-foreground mb-1.5 flex items-center gap-1.5">
                                <BookOpen className="h-3 w-3 text-muted-foreground" />
                                Bundled Skills
                                <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-mono rounded-sm">
                                    {plugin.skills.length}
                                </Badge>
                            </h4>
                            <div className="space-y-1">
                                {plugin.skills.map((skill) => (
                                    <div
                                        key={skill.name}
                                        className="px-2.5 py-1.5 rounded-md bg-muted/30 border border-border/30"
                                    >
                                        <span className="text-[11px] font-mono text-foreground">{skill.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Agents */}
                    {(plugin.agents?.length ?? 0) > 0 && (
                        <div>
                            <h4 className="text-xs font-medium text-foreground mb-1.5 flex items-center gap-1.5">
                                <Bot className="h-3 w-3 text-muted-foreground" />
                                Bundled Agents
                                <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-mono rounded-sm">
                                    {plugin.agents!.length}
                                </Badge>
                            </h4>
                            <div className="space-y-1">
                                {plugin.agents!.map((agent) => (
                                    <div
                                        key={agent.name}
                                        className="px-2.5 py-1.5 rounded-md bg-muted/30 border border-border/30"
                                    >
                                        <span className="text-[11px] font-mono text-foreground">{agent.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Rules */}
                    {(plugin.rules?.length ?? 0) > 0 && (
                        <div>
                            <h4 className="text-xs font-medium text-foreground mb-1.5 flex items-center gap-1.5">
                                <FileText className="h-3 w-3 text-muted-foreground" />
                                Rules
                                <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-mono rounded-sm">
                                    {plugin.rules.length}
                                </Badge>
                            </h4>
                            <div className="space-y-1">
                                {plugin.rules.map((rule) => (
                                    <div
                                        key={rule.name}
                                        className="px-2.5 py-1.5 rounded-md bg-muted/30 border border-border/30"
                                    >
                                        <span className="text-[11px] font-mono text-foreground">{rule.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Unsupported features */}
                    {(plugin.hasMcp || plugin.hasLsp) && (
                        <div className="rounded-md bg-amber-500/5 border border-amber-500/20 p-2.5">
                            <h4 className="text-[11px] font-medium text-amber-600 dark:text-amber-400 mb-1 flex items-center gap-1">
                                <AlertTriangle className="h-3 w-3" />
                                Not adapted (Claude Code–only)
                            </h4>
                            <div className="flex flex-wrap gap-1.5">
                                {plugin.hasMcp && (
                                    <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-600 dark:text-amber-400">
                                        <Server className="h-2.5 w-2.5 mr-1" />
                                        MCP Servers
                                    </Badge>
                                )}
                                {plugin.hasLsp && (
                                    <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-600 dark:text-amber-400">
                                        <FileText className="h-2.5 w-2.5 mr-1" />
                                        LSP Servers
                                    </Badge>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

// ── Hook event mapping (for UI display) ───────────────────────────────────────

const hookEventMapping: Record<string, string | null> = {
    PreToolUse: "tool_call",
    PostToolUse: "tool_result",
    PostToolUseFailure: "tool_result",
    UserPromptSubmit: "input",
    Stop: "agent_end",
    SessionStart: "session_start",
    SessionEnd: "session_shutdown",
    PreCompact: "session_before_compact",
    PermissionRequest: null,
    Notification: null,
    SubagentStart: null,
    SubagentStop: null,
    TeammateIdle: null,
    TaskCompleted: null,
    ConfigChange: null,
    WorktreeCreate: null,
    WorktreeRemove: null,
};

// ── Main component ────────────────────────────────────────────────────────────

export function PluginsManager({ runnerId, plugins: initialPlugins, onPluginsChange, bare }: PluginsManagerProps) {
    const [plugins, setPlugins] = React.useState<PluginInfo[]>(initialPlugins);
    const [open, setOpen] = React.useState(false);
    const [refreshing, setRefreshing] = React.useState(false);
    const [selectedPlugin, setSelectedPlugin] = React.useState<PluginInfo | null>(null);

    // Keep in sync with parent
    React.useEffect(() => {
        setPlugins(initialPlugins);
    }, [initialPlugins]);

    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/plugins/refresh`, {
                method: "POST",
                credentials: "include",
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.plugins)) {
                    const updated = data.plugins as PluginInfo[];
                    setPlugins(updated);
                    onPluginsChange?.(updated);
                }
            }
        } catch (err) {
            console.error("Failed to refresh plugins:", err);
        } finally {
            setRefreshing(false);
        }
    };

    const rescanButton = (
        <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleRefresh}
            disabled={refreshing}
        >
            {refreshing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
                <RefreshCw className="h-3 w-3" />
            )}
            <span className="ml-1">Rescan</span>
        </Button>
    );

    const pluginsList = (
        <div className={cn(bare ? "flex flex-col gap-1.5" : "mt-2 flex flex-col gap-1.5")}>
            {plugins.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-5 text-center">
                    <Puzzle className="h-5 w-5 text-muted-foreground/40" />
                    <div className="space-y-0.5">
                        <p className="text-xs font-medium text-muted-foreground">No plugins found</p>
                        <p className="text-[11px] text-muted-foreground/60 max-w-[220px]">
                            Add Claude Code plugins to{" "}
                            <span className="font-mono">~/.pizzapi/plugins/</span>{" "}
                            then click &ldquo;Rescan&rdquo;.
                        </p>
                    </div>
                </div>
            ) : (
                plugins.map((plugin) => (
                    <PluginRow
                        key={plugin.name}
                        plugin={plugin}
                        onClick={() => setSelectedPlugin(plugin)}
                    />
                ))
            )}
        </div>
    );

    return (
        <>
            {bare ? (
                <>
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-medium">Claude Plugins</h3>
                        {rescanButton}
                    </div>
                    {pluginsList}
                </>
            ) : (
                <Collapsible open={open} onOpenChange={setOpen}>
                    <div className="flex items-center justify-between mt-3">
                        <CollapsibleTrigger className="flex items-center gap-1.5 text-left group/trigger">
                            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                                Claude Plugins
                            </span>
                            <Badge
                                variant="secondary"
                                className="h-4 px-1.5 text-[10px] font-mono rounded-sm"
                            >
                                {plugins.length}
                            </Badge>
                            <ChevronDown
                                className={cn(
                                    "h-3 w-3 text-muted-foreground/60 transition-transform duration-200",
                                    open && "rotate-180"
                                )}
                            />
                        </CollapsibleTrigger>
                        {rescanButton}
                    </div>

                    <CollapsibleContent>
                        {pluginsList}
                    </CollapsibleContent>
                </Collapsible>
            )}

            <PluginDetailDialog
                plugin={selectedPlugin}
                onClose={() => setSelectedPlugin(null)}
            />
        </>
    );
}
