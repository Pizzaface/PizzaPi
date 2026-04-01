import { useState, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import * as ReactDOM from "react-dom";
import { cn } from "@/lib/utils";
import { GitBranch as GitBranchIcon, ChevronDown, Search, Check, Globe, Loader2, AlertCircle } from "lucide-react";
import type { GitBranch, BranchesState } from "@/hooks/useGitService";

interface GitBranchSelectorProps {
    currentBranch: string;
    branches: GitBranch[];
    branchesState: BranchesState;
    onCheckout: (branch: string, isRemote: boolean) => void;
    onOpen: () => void;
    disabled?: boolean;
    isCheckingOut?: boolean;
}

export function GitBranchSelector({
    currentBranch,
    branches,
    branchesState,
    onCheckout,
    onOpen,
    disabled,
    isCheckingOut,
}: GitBranchSelectorProps) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [dropdownStyle, setDropdownStyle] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });

    // Close on click outside
    useEffect(() => {
        if (!open) return;
        const handler = (e: PointerEvent) => {
            const target = e.target as Node;
            if (containerRef.current && containerRef.current.contains(target)) return;
            if (dropdownRef.current && dropdownRef.current.contains(target)) return;
            setOpen(false);
            setSearch("");
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

    // Position dropdown on open/resize/scroll
    useLayoutEffect(() => {
        if (!open) return;
        const updatePosition = () => {
            const trigger = containerRef.current;
            if (!trigger) return;
            const rect = trigger.getBoundingClientRect();
            setDropdownStyle({
                top: rect.bottom + window.scrollY,
                left: rect.left + window.scrollX,
                width: rect.width,
            });
        };
        updatePosition();
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);
        return () => {
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        };
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
        onCheckout(branch.name, branch.isRemote);
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

            {open && ReactDOM.createPortal(
                <div
                    ref={dropdownRef}
                    style={{
                        position: "absolute",
                        top: dropdownStyle.top,
                        left: dropdownStyle.left,
                        minWidth: dropdownStyle.width || 260,
                        maxWidth: "90vw",
                        zIndex: 60,
                    }}
                    className="mt-1 w-72 max-h-80 bg-popover border border-border rounded-lg shadow-xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-100"
                >
                    {/* Search / header */}
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
                        {branchesState.loading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
                    </div>

                    {/* Status bar for partial/error */}
                    {(branchesState.partial || branchesState.error) && (
                        <div className={cn(
                            "px-3 py-1 text-[0.7rem] border-b",
                            branchesState.error ? "text-red-500 border-border/50" : "text-muted-foreground border-border/50",
                        )}>
                            {branchesState.error ? (
                                <span className="inline-flex items-center gap-1"><AlertCircle className="size-3" />{branchesState.error}</span>
                            ) : (
                                "Partial data – status refresh needed for behind/ahead."
                            )}
                        </div>
                    )}

                    {/* Branch list */}
                    <div className="flex-1 overflow-auto py-1">
                        {branchesState.loading ? (
                            <div className="px-3 py-4 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
                                <Loader2 className="size-3 animate-spin" /> Loading branches…
                            </div>
                        ) : filtered.length === 0 ? (
                            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                                No branches found
                            </div>
                        ) : null}

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
                </div>,
                document.body,
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
