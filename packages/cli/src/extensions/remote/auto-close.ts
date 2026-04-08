export interface AutoCloseDecisionOptions {
    autoCloseEnv: string | undefined;
    exitReason: "completed" | "killed" | "error";
    isChildSession: boolean;
    hasPendingMessages: boolean;
    activeSubscriptionCount?: number | null;
    linkedChildCount?: number | null;
}

export function shouldAutoClose(opts: AutoCloseDecisionOptions): boolean {
    if (opts.isChildSession) return false;
    if (opts.autoCloseEnv !== "true") return false;
    if (opts.exitReason !== "completed") return false;
    if (opts.hasPendingMessages) return false;
    if (opts.activeSubscriptionCount == null) return false;
    if (opts.activeSubscriptionCount > 0) return false;
    if (opts.linkedChildCount == null) return false;
    if (opts.linkedChildCount > 0) return false;
    return true;
}
