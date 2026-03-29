import { useState } from "react";
import { Save, FileText, Info, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { SectionProps } from "./RunnerSettingsPanel";

export default function AgentRulesSettings({ config, onSave, saving }: SectionProps) {
    // agentsMd is passed alongside config from the settings_get_config response
    const initialContent = (config as any).__agentsMd ?? "";
    const [content, setContent] = useState<string>(initialContent);
    const [lastSaved, setLastSaved] = useState<string>(initialContent);

    const isDirty = content !== lastSaved;

    const handleSave = async () => {
        await onSave("agentsMd" as any, content);
        setLastSaved(content);
    };

    const handleReset = () => {
        setContent(lastSaved);
    };

    return (
        <div className="flex flex-col gap-4">
            {/* ── Header ──────────────────────────────────────────── */}
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

            {/* ── Editor ──────────────────────────────────────────── */}
            <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="# Agent Guidelines&#10;&#10;Add global instructions for all agent sessions here..."
                className={cn(
                    "font-mono text-sm min-h-[350px] resize-y leading-relaxed",
                    "bg-muted/50 border-border",
                )}
            />

            {/* ── Notes ───────────────────────────────────────────── */}
            <div className="flex flex-col gap-1.5 rounded-md bg-muted/40 border border-border px-3 py-2.5 text-xs text-muted-foreground">
                <p className="flex items-start gap-1.5">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    This file is loaded as project context into every agent session started by this runner.
                    Changes apply on next session start.
                </p>
                <p className="flex items-start gap-1.5">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    Use this for coding standards, branching rules, review checklists, and other persistent
                    instructions you want all agents to follow.
                </p>
            </div>

            {/* ── Actions ─────────────────────────────────────────── */}
            <div className="flex justify-end gap-2">
                {isDirty && (
                    <Button variant="outline" size="sm" onClick={handleReset} disabled={saving}>
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
