export async function severStaleParentLink(opts: {
    parentSessionId: string;
    childSessionId: string;
    clearParentField?: boolean;
    clearParentSessionId: (childSessionId: string) => Promise<void>;
    removeChildSession: (parentSessionId: string, childSessionId: string) => Promise<void>;
}): Promise<void> {
    if (opts.clearParentField) {
        await opts.clearParentSessionId(opts.childSessionId);
    }
    await opts.removeChildSession(opts.parentSessionId, opts.childSessionId);
}
