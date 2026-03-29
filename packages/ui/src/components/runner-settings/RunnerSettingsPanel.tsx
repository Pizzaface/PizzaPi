import * as React from "react";
import { useState, useEffect, useCallback } from "react";
import { Loader2, Settings, AlertTriangle, Save, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorAlert } from "@/components/ui/error-alert";
import { cn } from "@/lib/utils";

// Sub-tab components — lazy loaded
const ModelsSettings = React.lazy(() => import("./ModelsSettings"));
const McpServersSettings = React.lazy(() => import("./McpServersSettings"));
const HooksSettings = React.lazy(() => import("./HooksSettings"));
const SandboxSettings = React.lazy(() => import("./SandboxSettings"));
const WebSearchSettings = React.lazy(() => import("./WebSearchSettings"));
const SecuritySettings = React.lazy(() => import("./SecuritySettings"));
const EnvVarsSettings = React.lazy(() => import("./EnvVarsSettings"));
const SystemPromptSettings = React.lazy(() => import("./SystemPromptSettings"));
const AgentRulesSettings = React.lazy(() => import("./AgentRulesSettings"));
const TuiPrefsSettings = React.lazy(() => import("./TuiPrefsSettings"));

// ── Types ─────────────────────────────────────────────────────────────────────

export type SettingsSection =
    | "models"
    | "mcpServers"
    | "hooks"
    | "sandbox"
    | "webSearch"
    | "security"
    | "envVars"
    | "systemPrompt"
    | "agentsMd"
    | "tuiPreferences";

export interface RunnerSettingsPanelProps {
    runnerId: string;
}

export interface SettingsData {
    config: Record<string, any>;
    tuiSettings: Record<string, any>;
}

export interface SectionProps {
    runnerId: string;
    config: Record<string, any>;
    tuiSettings: Record<string, any>;
    onSave: (section: SettingsSection, value: unknown) => Promise<void>;
    saving: boolean;
}

// ── Sub-tab definitions ───────────────────────────────────────────────────────

const SETTINGS_TABS: { key: SettingsSection; label: string }[] = [
    { key: "models", label: "Models" },
    { key: "mcpServers", label: "MCP Servers" },
    { key: "hooks", label: "Hooks" },
    { key: "sandbox", label: "Sandbox" },
    { key: "webSearch", label: "Web Search" },
    { key: "security", label: "Security" },
    { key: "envVars", label: "Env Vars" },
    { key: "systemPrompt", label: "System Prompt" },
    { key: "agentsMd", label: "Agent Rules" },
    { key: "tuiPreferences", label: "TUI Prefs" },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function RunnerSettingsPanel({ runnerId }: RunnerSettingsPanelProps) {
    const [activeSection, setActiveSection] = useState<SettingsSection>("models");
    const [data, setData] = useState<SettingsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // Fetch settings from the runner
    const fetchSettings = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/settings`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            const result = await res.json();
            // Stash agentsMd in config as __agentsMd so section components can access it
            const config = result.config ?? {};
            if (result.agentsMd !== undefined) {
                config.__agentsMd = result.agentsMd;
            }
            setData({ config, tuiSettings: result.tuiSettings ?? {} });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [runnerId]);

    useEffect(() => {
        fetchSettings();
    }, [fetchSettings]);

    // Save a section
    const handleSave = useCallback(
        async (section: SettingsSection, value: unknown) => {
            setSaving(true);
            setError(null);
            try {
                const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/settings`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ section, value }),
                });
                if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    throw new Error(body.error ?? `HTTP ${res.status}`);
                }
                // Refresh config after save
                await fetchSettings();
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                throw err; // re-throw so the sub-tab can handle it
            } finally {
                setSaving(false);
            }
        },
        [runnerId, fetchSettings],
    );

    // ── Loading state ──────────────────────────────────────────────────
    if (loading && !data) {
        return (
            <div className="flex items-center justify-center p-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Loading settings…</span>
            </div>
        );
    }

    // ── Error state ────────────────────────────────────────────────────
    if (error && !data) {
        return (
            <div className="p-4">
                <ErrorAlert>{error}</ErrorAlert>
                <Button variant="outline" size="sm" className="mt-3" onClick={fetchSettings}>
                    <RotateCcw className="h-3.5 w-3.5 mr-1" />
                    Retry
                </Button>
            </div>
        );
    }

    if (!data) return null;

    // ── Section content ────────────────────────────────────────────────
    const sectionProps: SectionProps = {
        runnerId,
        config: data.config,
        tuiSettings: data.tuiSettings,
        onSave: handleSave,
        saving,
    };

    let content: React.ReactNode;
    switch (activeSection) {
        case "models":
            content = <ModelsSettings {...sectionProps} />;
            break;
        case "mcpServers":
            content = <McpServersSettings {...sectionProps} />;
            break;
        case "hooks":
            content = <HooksSettings {...sectionProps} />;
            break;
        case "sandbox":
            content = <SandboxSettings {...sectionProps} />;
            break;
        case "webSearch":
            content = <WebSearchSettings {...sectionProps} />;
            break;
        case "security":
            content = <SecuritySettings {...sectionProps} />;
            break;
        case "envVars":
            content = <EnvVarsSettings {...sectionProps} />;
            break;
        case "systemPrompt":
            content = <SystemPromptSettings {...sectionProps} />;
            break;
        case "agentsMd":
            content = <AgentRulesSettings {...sectionProps} />;
            break;
        case "tuiPreferences":
            content = <TuiPrefsSettings {...sectionProps} />;
            break;
    }

    return (
        <div className="flex flex-col gap-4">
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

            {/* Sub-tab pills */}
            <div className="overflow-x-auto -mx-1">
                <div className="flex flex-wrap gap-1.5 px-1">
                    {SETTINGS_TABS.map((tab) => (
                        <button
                            key={tab.key}
                            type="button"
                            onClick={() => setActiveSection(tab.key)}
                            className={cn(
                                "px-2.5 py-1 text-[11px] font-medium rounded-md transition-all whitespace-nowrap",
                                activeSection === tab.key
                                    ? "bg-blue-500/15 text-blue-300 border border-blue-500/30"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40 border border-transparent",
                            )}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Section content */}
            <React.Suspense
                fallback={
                    <div className="flex items-center justify-center p-8">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                }
            >
                {content}
            </React.Suspense>
        </div>
    );
}
