/**
 * AgentRulesEditor — standalone AGENTS.md editor.
 *
 * Fetches the global agent rules from the runner settings API and saves back.
 * Used in the top-level Agents tab.
 */
import { useState, useEffect, useCallback } from "react";
import { Save, FileText, Info, RotateCcw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ErrorAlert } from "@/components/ui/error-alert";
import { cn } from "@/lib/utils";

export interface AgentRulesEditorProps {
    runnerId: string;
}

export function AgentRulesEditor({ runnerId }: AgentRulesEditorProps) {
    const [content, setContent] = useState("");
    const [lastSaved, setLastSaved] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchRules = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/settings`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            const result = await res.json();
            const md = result.agentsMd ?? "";
            setContent(md);
            setLastSaved(md);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [runnerId]);

    useEffect(() => {
        fetchRules();
    }, [fetchRules]);

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/settings`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ section: "agentsMd", value: content }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            setLastSaved(content);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    };

    const isDirty = content !== lastSaved;

    if (loading) {
        return (
            <div className="flex items-center justify-center p-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Loading agent rules…</span>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {error && <ErrorAlert>{error}</ErrorAlert>}

            {/* Header */}
            <div className="flex flex-col gap-1">
                <Label className="flex items-center gap-2 text-sm font-medium">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    Global Agent Rules
                    <span className="text-xs font-normal text-muted-foreground">
                        ~/.pizzapi/AGENTS.md
                    </span>
                </Label>
                <p className="text-xs text-muted-foreground">
                    Instructions injected into every agent session. Use markdown for structure.
                </p>
            </div>

            {/* Editor */}
            <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="# Agent Guidelines&#10;&#10;Add global instructions for all agent sessions here..."
                className={cn(
                    "font-mono text-sm min-h-[350px] resize-y leading-relaxed",
                    "bg-muted/50 border-border",
                )}
            />

            {/* Notes */}
            <div className="flex flex-col gap-1.5 rounded-md bg-muted/40 border border-border px-3 py-2.5 text-xs text-muted-foreground">
                <p className="flex items-start gap-1.5">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    This file is loaded as project context into every agent session started by this
                    runner. Changes apply on next session start.
                </p>
                <p className="flex items-start gap-1.5">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    Use this for coding standards, branching rules, review checklists, and other
                    persistent instructions you want all agents to follow.
                </p>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2">
                {isDirty && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setContent(lastSaved)}
                        disabled={saving}
                    >
                        <RotateCcw className="h-4 w-4 mr-1.5" />
                        Discard
                    </Button>
                )}
                <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
                    <Save className="h-4 w-4 mr-1.5" />
                    {saving ? "Saving…" : "Save"}
                </Button>
            </div>
        </div>
    );
}
