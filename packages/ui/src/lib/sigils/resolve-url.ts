/**
 * Builds the tunnel-proxied sigil resolve URL.
 * `cwd` is infrastructure-provided (the session's project dir), never a
 * sigil inline param — inline `cwd`/`label`/`link`/`href` params are dropped.
 */
export function buildResolveUrl(opts: {
    runnerId: string;
    port: number;
    resolvePath: string;
    params?: Record<string, string>;
    sessionCwd?: string;
}): string {
    const search = new URLSearchParams(
        Object.entries(opts.params ?? {}).filter(
            ([k]) => !["label", "link", "href", "cwd"].includes(k),
        ),
    );
    if (opts.sessionCwd) search.set("cwd", opts.sessionCwd);
    const qs = search.toString() ? `?${search.toString()}` : "";
    return `/api/tunnel/runner/${encodeURIComponent(opts.runnerId)}/${opts.port}${opts.resolvePath}${qs}`;
}