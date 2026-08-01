/**
 * Relay URL helpers shared across the CLI.
 *
 * `localhost` may resolve to `::1` before `127.0.0.1` (notably on native
 * Windows), while the local relay is only reachable over IPv4 — Docker's
 * short-form port publish (`7492:7492`) binds the IPv4 wildcard only. A
 * loopback relay URL must therefore pin the IPv4 literal instead of relying
 * on resolver order. See #609 for the same bug class on the tunnel client.
 */

/**
 * Rewrite a `localhost` host to `127.0.0.1`, preserving scheme, userinfo,
 * port and path. Non-loopback hosts (including `[::1]`, which expresses
 * explicit IPv6 intent) are returned unchanged.
 */
export function normalizeLoopbackHost(url: string): string {
    return url.replace(
        /^((?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^/@]*@)?)localhost(?=[:/]|$)/i,
        "$1127.0.0.1",
    );
}
