import { useState } from "react";
import { Plus, X, Save, FileText, Info, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { SectionProps } from "./RunnerSettingsPanel";

export default function SystemPromptSettings({ config, onSave, saving }: SectionProps) {
    const [appendSystemPrompt, setAppendSystemPrompt] = useState<string>(
        (config.appendSystemPrompt as string) ?? "",
    );
    const [claudeCodeProvider, setClaudeCodeProvider] = useState<boolean>(
        (config.claudeCodeProvider as boolean) ?? false,
    );
    const [skills, setSkills] = useState<string[]>(
        Array.isArray(config.skills) ? (config.skills as string[]) : [],
    );
    const [newSkillPath, setNewSkillPath] = useState("");

    const addSkill = () => {
        const trimmed = newSkillPath.trim();
        if (trimmed && !skills.includes(trimmed)) {
            setSkills((prev) => [...prev, trimmed]);
            setNewSkillPath("");
        }
    };

    const removeSkill = (index: number) => {
        setSkills((prev) => prev.filter((_, i) => i !== index));
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            addSkill();
        }
    };

    const handleSave = () => {
        void onSave("systemPrompt", { appendSystemPrompt, skills, claudeCodeProvider });
    };

    return (
        <div className="flex flex-col gap-6">
            {/* ── Claude Code Provider Mode ────────────────────────── */}
            <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                    <Label htmlFor="claude-code-provider" className="flex items-center gap-2 text-sm font-medium">
                        <Shield className="h-4 w-4 text-muted-foreground" />
                        Claude Code Provider Mode
                    </Label>
                    <Switch
                        id="claude-code-provider"
                        checked={claudeCodeProvider}
                        onCheckedChange={setClaudeCodeProvider}
                    />
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                    Rewrites the system prompt to use &ldquo;Claude Code&rdquo; branding instead of
                    &ldquo;pi&rdquo; / &ldquo;PizzaPi&rdquo;. Useful for Anthropic Max subscriptions where
                    server-side detection checks the system prompt content.
                </p>
            </div>

            {/* ── Append System Prompt ──────────────────────────────── */}
            <div className="flex flex-col gap-2">
                <Label htmlFor="append-system-prompt" className="flex items-center gap-2 text-sm font-medium">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    Append System Prompt
                </Label>
                <Textarea
                    id="append-system-prompt"
                    value={appendSystemPrompt}
                    onChange={(e) => setAppendSystemPrompt(e.target.value)}
                    placeholder="Additional instructions appended to every session..."
                    className={cn(
                        "font-mono text-sm min-h-[150px] resize-y",
                        "bg-muted/50 border-border",
                    )}
                />
            </div>

            {/* ── Skills Paths ─────────────────────────────────────── */}
            <div className="flex flex-col gap-2">
                <Label className="flex items-center gap-2 text-sm font-medium">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    Skill Paths
                </Label>

                {skills.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                        {skills.map((skill, index) => (
                            <span
                                key={`${skill}-${index}`}
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs",
                                    "font-mono bg-muted border border-border text-foreground",
                                )}
                            >
                                {skill}
                                <button
                                    type="button"
                                    onClick={() => removeSkill(index)}
                                    className="rounded-full p-0.5 hover:bg-destructive/20 hover:text-destructive transition-colors"
                                    aria-label={`Remove ${skill}`}
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </span>
                        ))}
                    </div>
                )}

                <div className="flex gap-2">
                    <Input
                        value={newSkillPath}
                        onChange={(e) => setNewSkillPath(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="/path/to/skills/directory"
                        className="font-mono text-sm flex-1"
                    />
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addSkill}
                        disabled={!newSkillPath.trim()}
                    >
                        <Plus className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* ── Notes ────────────────────────────────────────────── */}
            <div className="flex flex-col gap-1.5 rounded-md bg-muted/40 border border-border px-3 py-2.5 text-xs text-muted-foreground">
                <p className="flex items-start gap-1.5">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    The system prompt text is appended after the built-in prompt. Skill paths are merged with
                    default locations (<code className="font-mono">~/.pizzapi/skills/</code> and{" "}
                    <code className="font-mono">.pizzapi/skills/</code>).
                </p>
                <p className="flex items-start gap-1.5">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    Changes apply on next session start.
                </p>
            </div>

            {/* ── Save ─────────────────────────────────────────────── */}
            <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving} size="sm">
                    <Save className="h-4 w-4 mr-1.5" />
                    {saving ? "Saving…" : "Save"}
                </Button>
            </div>
        </div>
    );
}
