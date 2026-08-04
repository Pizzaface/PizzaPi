/**
 * GitAddWorktreeDialog — create a worktree without free-text prompts.
 *
 * Two modes: create a NEW branch (name + base ref) or check out an EXISTING
 * branch (local/remote dropdown). Path is auto-suggested from the branch and
 * stays editable.
 */
import { useState, useMemo, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { GitBranch, FolderGit2 } from "lucide-react";
import type { GitBranch as GitBranchType } from "@/hooks/useGitService";

interface GitAddWorktreeDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    branches: GitBranchType[];
    currentBranch: string;
    onOpenBranches: () => void;
    onCreate: (branch: string, path: string, opts?: { base?: string; create?: boolean; isRemote?: boolean }) => void;
    isBusy?: boolean;
}

function slug(branch: string): string {
    // strip a leading remote (origin/…) then slugify slashes
    const local = branch.includes("/") ? branch.slice(branch.indexOf("/") + 1) : branch;
    return local.replace(/\//g, "-").replace(/^-+|-+$/g, "");
}

export function GitAddWorktreeDialog({
    open,
    onOpenChange,
    branches,
    currentBranch,
    onOpenBranches,
    onCreate,
    isBusy = false,
}: GitAddWorktreeDialogProps) {
    const [mode, setMode] = useState<"new" | "existing">("new");
    const [newBranch, setNewBranch] = useState("");
    const [base, setBase] = useState<string>("");
    const [existing, setExisting] = useState<string>("");
    const [path, setPath] = useState("");
    const [pathEdited, setPathEdited] = useState(false);

    const local = useMemo(() => branches.filter((b) => !b.isRemote), [branches]);
    const remote = useMemo(() => branches.filter((b) => b.isRemote), [branches]);
    const existingBranch = branches.find((b) => b.name === existing);

    // Refresh branch list + reset when opened.
    useEffect(() => {
        if (!open) return;
        onOpenBranches();
        setMode("new");
        setNewBranch("");
        setBase(currentBranch || "HEAD");
        setExisting("");
        setPath("");
        setPathEdited(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // Auto-suggest the path from the active branch unless the user edited it.
    const activeBranchName = mode === "new" ? newBranch : existing;
    useEffect(() => {
        if (pathEdited) return;
        const s = slug(activeBranchName);
        setPath(s ? `.worktrees/${s}` : "");
    }, [activeBranchName, pathEdited]);

    const canCreate =
        !isBusy &&
        path.trim().length > 0 &&
        (mode === "new" ? newBranch.trim().length > 0 : existing.length > 0);

    const handleCreate = useCallback(() => {
        if (!canCreate) return;
        if (mode === "new") {
            onCreate(newBranch.trim(), path.trim(), { create: true, base: base && base !== "HEAD" ? base : undefined });
        } else if (existingBranch?.isRemote) {
            onCreate(existingBranch.name, path.trim(), { isRemote: true });
        } else {
            onCreate(existing, path.trim());
        }
        onOpenChange(false);
    }, [canCreate, mode, newBranch, path, base, existing, existingBranch, onCreate, onOpenChange]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-sm">
                        <FolderGit2 className="size-4" /> New worktree
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-3">
                    {/* Mode toggle */}
                    <div className="inline-flex rounded-md border border-border p-0.5 bg-muted/40 text-xs w-full">
                        {(["new", "existing"] as const).map((m) => (
                            <button
                                key={m}
                                type="button"
                                onClick={() => setMode(m)}
                                className={cn(
                                    "flex-1 px-3 py-1.5 rounded transition-colors",
                                    mode === m ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                                )}
                            >
                                {m === "new" ? "New branch" : "Existing branch"}
                            </button>
                        ))}
                    </div>

                    {mode === "new" ? (
                        <>
                            <label className="block space-y-1">
                                <span className="text-xs text-muted-foreground">Branch name</span>
                                <Input
                                    value={newBranch}
                                    onChange={(e) => setNewBranch(e.target.value)}
                                    placeholder="feat/my-feature"
                                    className="font-mono text-sm"
                                    autoFocus
                                />
                            </label>
                            <label className="block space-y-1">
                                <span className="text-xs text-muted-foreground">Base</span>
                                <BranchSelect
                                    value={base}
                                    onChange={setBase}
                                    local={local}
                                    remote={remote}
                                    includeHead
                                    placeholder="Base ref"
                                />
                            </label>
                        </>
                    ) : (
                        <label className="block space-y-1">
                            <span className="text-xs text-muted-foreground">Branch</span>
                            <BranchSelect
                                value={existing}
                                onChange={setExisting}
                                local={local.filter((b) => b.name !== currentBranch)}
                                remote={remote}
                                placeholder="Choose a branch"
                            />
                        </label>
                    )}

                    <label className="block space-y-1">
                        <span className="text-xs text-muted-foreground">Directory</span>
                        <Input
                            value={path}
                            onChange={(e) => { setPath(e.target.value); setPathEdited(true); }}
                            placeholder=".worktrees/my-feature"
                            className="font-mono text-sm"
                        />
                    </label>
                </div>

                <DialogFooter>
                    <button
                        type="button"
                        onClick={() => onOpenChange(false)}
                        className="px-3 py-1.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleCreate}
                        disabled={!canCreate}
                        className={cn(
                            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium",
                            canCreate ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-muted text-muted-foreground cursor-not-allowed",
                        )}
                    >
                        <GitBranch className="size-3.5" /> Create worktree
                    </button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function BranchSelect({
    value,
    onChange,
    local,
    remote,
    includeHead = false,
    placeholder,
}: {
    value: string;
    onChange: (v: string) => void;
    local: GitBranchType[];
    remote: GitBranchType[];
    includeHead?: boolean;
    placeholder: string;
}) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger className="w-full h-9 text-sm">
                <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent className="max-h-72">
                {includeHead && (
                    <SelectGroup>
                        <SelectItem value="HEAD"><span className="font-mono text-xs">HEAD (current)</span></SelectItem>
                    </SelectGroup>
                )}
                {local.length > 0 && (
                    <SelectGroup>
                        <SelectLabel className="text-[0.65rem] uppercase tracking-wider">Local</SelectLabel>
                        {local.map((b) => (
                            <SelectItem key={`local-${b.name}`} value={b.name}><span className="font-mono text-xs">{b.name}</span></SelectItem>
                        ))}
                    </SelectGroup>
                )}
                {remote.length > 0 && (
                    <SelectGroup>
                        <SelectLabel className="text-[0.65rem] uppercase tracking-wider">Remote</SelectLabel>
                        {remote.map((b) => (
                            <SelectItem key={`remote-${b.name}`} value={b.name}><span className="font-mono text-xs">{b.name}</span></SelectItem>
                        ))}
                    </SelectGroup>
                )}
                {local.length === 0 && remote.length === 0 && !includeHead && (
                    <div className="px-2 py-2 text-xs text-muted-foreground">No branches</div>
                )}
            </SelectContent>
        </Select>
    );
}
