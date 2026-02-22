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
    BookOpen,
    Loader2,
    Plus,
    Pencil,
    Trash2,
    ChevronDown,
    Wand2,
    AlertCircle,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillInfo {
    name: string;
    description: string;
    filePath: string;
}

export interface SkillsManagerProps {
    runnerId: string;
    /** Initial skill list (already fetched by parent) */
    skills: SkillInfo[];
    /** Called when skills change so the parent can update its state */
    onSkillsChange?: (skills: SkillInfo[]) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildDefaultSkillContent(name: string, description: string): string {
    return `---
name: ${name}
description: ${description || `A custom skill named ${name}.`}
---

# ${name}

## Overview

Describe what this skill does and when to use it.

## Usage

Provide step-by-step instructions for the agent here.
`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface SkillRowProps {
    skill: SkillInfo;
    onEdit: (skill: SkillInfo) => void;
    onDelete: (skill: SkillInfo) => void;
    deleting: boolean;
}

function SkillRow({ skill, onEdit, onDelete, deleting }: SkillRowProps) {
    return (
        <div className="flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg border border-border/40 bg-muted/20 hover:bg-muted/40 transition-colors group">
            <div className="flex items-start gap-2.5 min-w-0">
                <BookOpen className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-primary/60" />
                <div className="min-w-0">
                    <p className="text-xs font-semibold font-mono truncate text-foreground">{skill.name}</p>
                    {skill.description && (
                        <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{skill.description}</p>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                    onClick={() => onEdit(skill)}
                    title="Edit skill"
                >
                    <Pencil className="h-3 w-3" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(skill)}
                    disabled={deleting}
                    title="Delete skill"
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

// ── Skill editor dialog ───────────────────────────────────────────────────────

interface SkillEditorDialogProps {
    runnerId: string;
    open: boolean;
    /** null = creating new, SkillInfo = editing existing */
    skill: SkillInfo | null;
    onClose: () => void;
    onSaved: (updatedSkills: SkillInfo[]) => void;
}

function SkillEditorDialog({ runnerId, open, skill, onClose, onSaved }: SkillEditorDialogProps) {
    const isEditing = skill !== null;

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
        setName(skill.name);
        setContent("");

        fetch(`/api/runners/${encodeURIComponent(runnerId)}/skills/${encodeURIComponent(skill.name)}`, {
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
    }, [open, isEditing, skill, runnerId]);

    const handleGenerateTemplate = () => {
        const descMatch = content.match(/^description:\s*(.+)$/m);
        const desc = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : "";
        setContent(buildDefaultSkillContent(name || "my-skill", desc));
    };

    const handleSave = async () => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            setError("Skill name is required");
            return;
        }

        // Validate name
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(trimmedName)) {
            setError("Name must contain only lowercase letters, numbers, and hyphens");
            return;
        }

        setSaving(true);
        setError(null);

        try {
            const url = isEditing
                ? `/api/runners/${encodeURIComponent(runnerId)}/skills/${encodeURIComponent(trimmedName)}`
                : `/api/runners/${encodeURIComponent(runnerId)}/skills`;

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
                setError(data?.error ?? `Failed to save skill (HTTP ${res.status})`);
                return;
            }

            onSaved(Array.isArray(data?.skills) ? data.skills : []);
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
                    <DialogTitle>{isEditing ? `Edit skill: ${skill?.name}` : "New Agent Skill"}</DialogTitle>
                    <DialogDescription>
                        {isEditing
                            ? "Edit the SKILL.md content for this skill."
                            : "Create a new agent skill in the global ~/.pizzapi/skills/ directory."}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto py-1">
                    {/* Name (only editable when creating) */}
                    {!isEditing && (
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="skill-name" className="text-sm">
                                Skill name
                                <span className="ml-1 text-muted-foreground font-normal">(lowercase, hyphens)</span>
                            </Label>
                            <Input
                                id="skill-name"
                                placeholder="my-skill"
                                value={name}
                                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                                className="font-mono text-sm"
                                disabled={saving}
                            />
                        </div>
                    )}

                    {/* SKILL.md content */}
                    <div className="flex flex-col gap-1.5 flex-1 min-h-0">
                        <div className="flex items-center justify-between">
                            <Label htmlFor="skill-content" className="text-sm">
                                SKILL.md content
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
                                Loading skill content…
                            </div>
                        ) : (
                            <textarea
                                id="skill-content"
                                className={cn(
                                    "flex-1 min-h-[280px] w-full rounded-md border border-input bg-background px-3 py-2",
                                    "font-mono text-xs resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                                    "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
                                )}
                                placeholder={`---\nname: my-skill\ndescription: What this skill does and when to use it.\n---\n\n# My Skill\n\n## Usage\n\n...`}
                                value={content}
                                onChange={(e) => setContent(e.target.value)}
                                disabled={saving}
                                spellCheck={false}
                            />
                        )}
                    </div>

                    {error && (
                        <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                            {error}
                        </div>
                    )}
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
                                <BookOpen className="mr-2 h-4 w-4" />
                                {isEditing ? "Save Changes" : "Create Skill"}
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ── Delete confirmation dialog ────────────────────────────────────────────────

interface DeleteSkillDialogProps {
    runnerId: string;
    skill: SkillInfo | null;
    onClose: () => void;
    onDeleted: (updatedSkills: SkillInfo[]) => void;
}

function DeleteSkillDialog({ runnerId, skill, onClose, onDeleted }: DeleteSkillDialogProps) {
    const [deleting, setDeleting] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const handleDelete = async () => {
        if (!skill) return;
        setDeleting(true);
        setError(null);

        try {
            const res = await fetch(`/api/runners/${encodeURIComponent(runnerId)}/skills/${encodeURIComponent(skill.name)}`, {
                method: "DELETE",
                credentials: "include",
            });
            const data = await res.json().catch(() => null) as any;
            if (!res.ok) {
                setError(data?.error ?? `Failed to delete skill (HTTP ${res.status})`);
                return;
            }
            onDeleted(Array.isArray(data?.skills) ? data.skills : []);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setDeleting(false);
        }
    };

    return (
        <Dialog open={skill !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>Delete skill</DialogTitle>
                    <DialogDescription>
                        Are you sure you want to delete{" "}
                        <span className="font-mono font-semibold text-foreground">{skill?.name}</span>?
                        This will remove the skill directory from the runner.
                    </DialogDescription>
                </DialogHeader>

                {error && (
                    <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
                        <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                        {error}
                    </div>
                )}

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

export function SkillsManager({ runnerId, skills: initialSkills, onSkillsChange }: SkillsManagerProps) {
    const [skills, setSkills] = React.useState<SkillInfo[]>(initialSkills);
    const [open, setOpen] = React.useState(false);

    // Editor dialog state
    const [editorOpen, setEditorOpen] = React.useState(false);
    const [editingSkill, setEditingSkill] = React.useState<SkillInfo | null>(null);

    // Delete dialog state
    const [deletingSkill, setDeletingSkill] = React.useState<SkillInfo | null>(null);
    const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);

    // Keep in sync with parent
    React.useEffect(() => {
        setSkills(initialSkills);
    }, [initialSkills]);

    const handleSkillsChange = (updated: SkillInfo[]) => {
        setSkills(updated);
        onSkillsChange?.(updated);
    };

    const handleEdit = (skill: SkillInfo) => {
        setEditingSkill(skill);
        setEditorOpen(true);
    };

    const handleDeleteRequest = (skill: SkillInfo) => {
        setPendingDelete(skill.name);
        setDeletingSkill(skill);
    };

    const handleNewSkill = () => {
        setEditingSkill(null);
        setEditorOpen(true);
    };

    return (
        <>
            <Collapsible open={open} onOpenChange={setOpen}>
                <div className="flex items-center justify-between mt-3">
                    <CollapsibleTrigger className="flex items-center gap-1.5 text-left group/trigger">
                        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                            Agent Skills
                        </span>
                        <Badge
                            variant="secondary"
                            className="h-4 px-1.5 text-[10px] font-mono rounded-sm"
                        >
                            {skills.length}
                        </Badge>
                        <ChevronDown
                            className={cn(
                                "h-3 w-3 text-muted-foreground/60 transition-transform duration-200",
                                open && "rotate-180"
                            )}
                        />
                    </CollapsibleTrigger>

                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                        onClick={handleNewSkill}
                    >
                        <Plus className="h-3 w-3 mr-1" />
                        New skill
                    </Button>
                </div>

                <CollapsibleContent>
                    <div className="mt-2 flex flex-col gap-1.5">
                        {skills.length === 0 ? (
                            <div className="flex flex-col items-center gap-2 py-5 text-center">
                                <BookOpen className="h-5 w-5 text-muted-foreground/40" />
                                <div className="space-y-0.5">
                                    <p className="text-xs font-medium text-muted-foreground">No skills yet</p>
                                    <p className="text-[11px] text-muted-foreground/60 max-w-[200px]">
                                        Add a SKILL.md to{" "}
                                        <span className="font-mono">~/.pizzapi/skills/</span>{" "}
                                        or click &ldquo;New skill&rdquo; above.
                                    </p>
                                </div>
                            </div>
                        ) : (
                            skills.map((skill) => (
                                <SkillRow
                                    key={skill.name}
                                    skill={skill}
                                    onEdit={handleEdit}
                                    onDelete={handleDeleteRequest}
                                    deleting={pendingDelete === skill.name}
                                />
                            ))
                        )}
                    </div>
                </CollapsibleContent>
            </Collapsible>

            <SkillEditorDialog
                runnerId={runnerId}
                open={editorOpen}
                skill={editingSkill}
                onClose={() => { setEditorOpen(false); setEditingSkill(null); }}
                onSaved={(updated) => { handleSkillsChange(updated); }}
            />

            <DeleteSkillDialog
                runnerId={runnerId}
                skill={deletingSkill}
                onClose={() => { setDeletingSkill(null); setPendingDelete(null); }}
                onDeleted={(updated) => { handleSkillsChange(updated); setPendingDelete(null); }}
            />
        </>
    );
}
