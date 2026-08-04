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

/**
 * Normalize a relay URL for HTTP(S) REST calls (setup-claim endpoints, any
 * plain `fetch()`). A relay URL saved to config.json round-trips in ws(s)://
 * form — that's what the daemon's own socket.io connection wants, and what
 * pairing persists on success — so anything that later reads it back for a
 * REST call (a second `pizza runner pair`, auto-pairing after `apiKey` was
 * cleared but `relayUrl` wasn't) must convert it back. A bare hostname with
 * no scheme defaults to https, mirroring the daemon's own socket.io URL
 * resolution.
 */
export function toHttpRelayUrl(raw: string): string {
    if (raw.startsWith("ws://")) return raw.replace(/^ws:\/\//, "http://");
    if (raw.startsWith("wss://")) return raw.replace(/^wss:\/\//, "https://");
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
    return `https://${raw}`;
}
