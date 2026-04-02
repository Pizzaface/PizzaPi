import type { GitOperationResult } from "@/hooks/useGitService";

export type GitToastAction = "setUpstream";

export interface GitOperationFeedback {
    type: "success" | "error";
    message: string;
    action?: GitToastAction;
}

export function parseUpstreamRef(input: string): { remote: string; branch: string } | null {
    const value = input.trim();
    const slashIndex = value.indexOf("/");
    if (slashIndex <= 0 || slashIndex === value.length - 1) return null;

    const remote = value.slice(0, slashIndex).trim();
    const branch = value.slice(slashIndex + 1).trim();
    if (!remote || !branch) return null;
    return { remote, branch };
}

export function getGitOperationFeedback(result: GitOperationResult): GitOperationFeedback {
    if (result.ok) {
        const message = (result.summary as string)
            ?? (result.output as string)
            ?? (result.branch ? `Switched to ${result.branch as string}` : null)
            ?? "Done";
        return { type: "success", message };
    }

    if (result.noUpstream || result.reason === "missingUpstream") {
        return {
            type: "error",
            message: "This branch has no upstream configured. Set an upstream branch, then pull again.",
            action: "setUpstream",
        };
    }

    if (result.reason === "ambiguousUpstream") {
        return {
            type: "error",
            message: "This branch has an ambiguous upstream configuration. Repair it by setting exactly one upstream branch.",
            action: "setUpstream",
        };
    }

    if (result.reason === "detachedHead") {
        return {
            type: "error",
            message: "Cannot sync while HEAD is detached. Check out a branch first.",
        };
    }

    if (result.reason === "conflict") {
        return {
            type: "error",
            message: (result.message as string) ?? "Sync stopped because of conflicts.",
        };
    }

    return {
        type: "error",
        message: (result.message as string) ?? "Operation failed",
    };
}
