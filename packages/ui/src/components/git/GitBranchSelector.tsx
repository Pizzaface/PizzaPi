import { useState, useMemo, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { GitBranch as GitBranchIcon, ChevronDown, Search, Check, Globe, Loader2 } from "lucide-react";
import type { GitBranch } from "@/hooks/useGitService";

interface GitBranchSelectorProps {
    currentBranch: string;
    branches: GitBranch[];
    onCheckout: (branch: string) => void;
    onOpen: () => void;
    disabled?: boolean;
    isCheckingOut?: boolean;
}

export function GitBranchSelector({
    currentBranch,
    branches,
    onCheckout,
    onOpen,
    disabled,
    isCheckingOut,
}: GitBranchSelectorProps) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const containerRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    // Close on click outside
    useEffect(() => {
        if (!open) return;
        const handler = (e: PointerEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false);
                setSearch("");
            }
        };
        document.addEventListener("pointerdown", handler, true);
        return () => document.removeEventListener("pointerdown", handler, true);
    }, [open]);

    // Close on Escape
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
                setSearch("");
            }
        };
        document.addEventListener("keydown", handler, true);
        return () => document.removeEventListener("keydown", handler, true);
    }, [open]);

    // Auto-focus search on open
    useEffect(() => {
        if (open) {
            searchInputRef.current?.focus();
        }
    }, [open]);

    const handleOpen = () => {
        if (disabled || isCheckingOut) return;
        onOpen(); // Fetch branches
        setOpen(true);
    };

    const handleSelect = (branch: GitBranch) => {
        if (branch.isCurrent) {
            setOpen(false);
            setSearch("");
            return;
        }
        onCheckout(branch.name);
        setOpen(false);
        setSearch("");
    };

    const filtered = useMemo(() => {
        if (!search) return branches;
        const q = search.toLowerCase();
        return branches.filter((b) => b.name.toLowerCase().includes(q));
    }, [branches, search]);

    const localBranches = filtered.filter((b) => !b.isRemote);
    const remoteBranches = filtered.filter((b) => b.isRemote);

    return (
        <div ref={containerRef} className="relative">
            <button
                type="button"
                onClick={handleOpen}
                disabled={disabled || isCheckingOut}
                className={cn(
                    "inline-flex items-center gap-1.5 px-2 py-1 rounded text-sm font-medium transition-colors",
                    "hover:bg-accent/60 text-foreground",
                    disabled && "opacity-50 cursor-not-allowed",
                )}
            >
                <GitBranchIcon className="size-4 text-green-600 dark:text-green-400" />
                <span className="truncate max-w-[200px]">{currentBranch || "detached"}</span>
                {isCheckingOut ? (
                    <Loader2 className="size-3 animate-spin" />
                ) : (
                    <ChevronDown className="size-3 text-muted-foreground" />
                )}
            </button>

            {open && (
                <div className="absolute top-full left-0 mt-1 w-72 max-h-80 bg-popover border border-border rounded-lg shadow-xl z-50 flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-100">
                    {/* Search */}
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
                        <Search className="size-3.5 text-muted-foreground flex-shrink-0" />
                        <input
                            ref={searchInputRef}
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Find a branch…"
                            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                        />
                    </div>

                    {/* Branch list */}
                    <div className="flex-1 overflow-auto py-1">
                        {filtered.length === 0 && (
                            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                                No branches found
                            </div>
                        )}

                        {localBranches.length > 0 && (
                            <div>
                                <div className="px-3 py-1 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
                                    Local
                                </div>
                                {localBranches.map((branch) => (
                                    <BranchItem
                                        key={branch.name}
                                        branch={branch}
                                        onSelect={handleSelect}
                                    />
                                ))}
                            </div>
                        )}

                        {remoteBranches.length > 0 && (
                            <div className={localBranches.length > 0 ? "mt-1" : ""}>
                                <div className="px-3 py-1 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground/70">
                                    Remote
                                </div>
                                {remoteBranches.map((branch) => (
                                    <BranchItem
                                        key={branch.name}
                                        branch={branch}
                                        onSelect={handleSelect}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function BranchItem({ branch, onSelect }: { branch: GitBranch; onSelect: (b: GitBranch) => void }) {
    return (
        <button
            type="button"
            onClick={() => onSelect(branch)}
            className={cn(
                "flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left transition-colors",
                branch.isCurrent
                    ? "bg-accent/40 text-foreground"
                    : "hover:bg-accent/60 text-foreground/80",
            )}
        >
            <span className="flex-shrink-0 w-4">
                {branch.isCurrent ? (
                    <Check className="size-3.5 text-green-600 dark:text-green-400" />
                ) : branch.isRemote ? (
                    <Globe className="size-3 text-muted-foreground" />
                ) : (
                    <GitBranchIcon className="size-3 text-muted-foreground" />
                )}
            </span>
            <span className="truncate flex-1 font-mono text-xs">{branch.name}</span>
            <span className="text-[0.6rem] text-muted-foreground flex-shrink-0 tabular-nums">
                {branch.shortHash}
            </span>
        </button>
    );
}
