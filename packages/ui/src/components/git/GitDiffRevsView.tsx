/**
 * GitDiffRevsView — diff any two revisions.
 *
 * Revision pickers are populated from local branches and the recent commit
 * log. Calls fetchDiffRevs(base, head, path?) and renders the resulting diff.
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useGitService, type GitLogEntry } from "@/hooks/useGitService";
import { GitBranch, Diff, GitCommit } from "lucide-react";

interface GitDiffRevsViewProps {
    cwd: string;
    path?: string;
    className?: string;
}

interface RevOption {
    value: string;
    label: string;
    group: string;
}

export function GitDiffRevsView({ cwd, path, className }: GitDiffRevsViewProps) {
    const git = useGitService(cwd);
    const [base, setBase] = useState("");
    const [head, setHead] = useState("");
    const [diff, setDiff] = useState("");
    const [loading, setLoading] = useState(false);

    const log = git.log ?? [];
    const branches = git.branches ?? [];

    useEffect(() => {
        setBase("");
        setHead("");
        setDiff("");
        git.fetchLog(path, 25);
    }, [cwd, path]);

    // Default base to the current branch once we know it.
    useEffect(() => {
        if (base || !git.currentBranch) return;
        setBase(git.currentBranch);
    }, [git.currentBranch, base]);

    const options = useMemo<RevOption[]>(() => {
        const opts: RevOption[] = [];
        branches
            .filter((b) => !b.isRemote)
            .forEach((b) => {
                opts.push({ value: b.name, label: b.name, group: "Branches" });
            });
        log.forEach((entry) => {
            opts.push({
                value: entry.hash,
                label: `${entry.shortHash} — ${entry.subject}`,
                group: "Recent commits",
            });
        });
        return opts;
    }, [branches, log]);

    const handleDiff = async () => {
        if (!base || !head || base === head || loading) return;
        setLoading(true);
        try {
            const result = await git.fetchDiffRevs(base, head, path);
            setDiff(result);
        } catch {
            setDiff("(failed to load diff)");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className={cn("flex flex-col h-full overflow-hidden", className)}>
            <div className="flex flex-col @sm:flex-row items-start @sm:items-center gap-2 p-2 border-b border-border bg-muted/30 shrink-0">
                <RevPicker
                    label="Base"
                    value={base}
                    onChange={setBase}
                    options={options}
                    icon={<GitBranch className="size-3.5 text-muted-foreground" />}
                />
                <RevPicker
                    label="Head"
                    value={head}
                    onChange={setHead}
                    options={options}
                    icon={<GitCommit className="size-3.5 text-muted-foreground" />}
                />
                {path && <Badge variant="outline" className="text-xs">{path}</Badge>}
                <Button
                    size="sm"
                    disabled={!base || !head || base === head || loading}
                    onClick={handleDiff}
                    className="w-full @sm:w-auto h-9"
                >
                    <Diff className="size-3.5" />
                    <span className="ml-1.5">Diff</span>
                </Button>
            </div>

            <div className="flex-1 overflow-y-auto overflow-x-hidden">
                {!diff && !loading ? (
                    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
                        <Diff className="size-8 opacity-30" />
                        <p className="text-sm">Choose two revisions to compare</p>
                    </div>
                ) : (
                    <GitDiffCode diff={diff} loading={loading} />
                )}
            </div>
        </div>
    );
}

function RevPicker({
    label,
    value,
    onChange,
    options,
    icon,
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: RevOption[];
    icon: React.ReactNode;
}) {
    const grouped = useMemo(() => {
        const map = new Map<string, RevOption[]>();
        for (const opt of options) {
            const list = map.get(opt.group) ?? [];
            list.push(opt);
            map.set(opt.group, list);
        }
        return map;
    }, [options]);

    return (
        <div className="flex items-center gap-2 w-full @sm:flex-1 min-w-0">
            <span className="text-xs text-muted-foreground shrink-0 w-10">{label}</span>
            <Select value={value} onValueChange={onChange}>
                <SelectTrigger className="w-full h-9 min-w-0">
                    <span className="shrink-0">{icon}</span>
                    <SelectValue placeholder={`Choose ${label.toLowerCase()}…`} />
                </SelectTrigger>
                <SelectContent className="max-w-[90vw]">
                    {Array.from(grouped.entries()).map(([group, items], groupIndex, entries) => (
                        <SelectGroup key={group}>
                            <SelectLabel>{group}</SelectLabel>
                            {items.map((opt) => (
                                <SelectItem key={`${group}:${opt.value}`} value={opt.value}>
                                    <span className="truncate">{opt.label}</span>
                                </SelectItem>
                            ))}
                            {groupIndex < entries.length - 1 && (
                                <SelectSeparator />
                            )}
                        </SelectGroup>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}

function GitDiffCode({ diff, loading }: { diff: string; loading?: boolean }) {
    if (loading) {
        return (
            <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
                <span className="inline-block size-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                <span className="text-sm">Loading diff…</span>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">
            <pre className="p-3 text-xs font-mono leading-relaxed whitespace-pre overflow-x-auto min-w-full">
                {diff.split("\n").map((line, i) => {
                    let color = "text-muted-foreground";
                    if (line.startsWith("+") && !line.startsWith("+++")) {
                        color = "text-green-600 dark:text-green-400";
                    } else if (line.startsWith("-") && !line.startsWith("---")) {
                        color = "text-red-600 dark:text-red-400";
                    } else if (line.startsWith("@@")) {
                        color = "text-blue-600 dark:text-blue-400";
                    } else if (line.startsWith("diff ") || line.startsWith("index ")) {
                        color = "text-muted-foreground/70";
                    }
                    return (
                        <div key={i} className={cn(color, "min-h-[1.25em]")}>
                            {line || "\u00A0"}
                        </div>
                    );
                })}
            </pre>
        </div>
    );
}
