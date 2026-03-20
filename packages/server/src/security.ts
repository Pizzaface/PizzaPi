import { posix as path } from "path";

export class RateLimiter {
    private hits = new Map<string, { count: number; resetTime: number }>();
    private cleanupInterval: ReturnType<typeof setInterval>;

    /**
     * @param limit Max requests per window
     * @param windowMs Time window in milliseconds
     */
    constructor(private limit: number, private windowMs: number) {
        // Clean up expired entries every minute to prevent memory leaks
        this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
        // Ensure cleanup stops if the process exits (though for a long-running server this isn't strictly necessary)
        if (typeof this.cleanupInterval === 'object' && 'unref' in this.cleanupInterval) {
            (this.cleanupInterval as any).unref();
        }
    }

    /**
     * Checks if a request from the given key is allowed.
     * @param key Unique identifier (e.g., IP address)
     * @returns true if allowed, false if limit exceeded
     */
    check(key: string): boolean {
        const now = Date.now();
        const record = this.hits.get(key);

        if (!record || now > record.resetTime) {
            this.hits.set(key, { count: 1, resetTime: now + this.windowMs });
            return true;
        }

        if (record.count >= this.limit) {
            return false;
        }

        record.count++;
        return true;
    }

    private cleanup() {
        const now = Date.now();
        for (const [key, record] of this.hits.entries()) {
            if (now > record.resetTime) {
                this.hits.delete(key);
            }
        }
    }

    // For testing purposes
    destroy() {
        clearInterval(this.cleanupInterval);
    }
}

export function isValidEmail(email: string): boolean {
    // Simple but effective regex for most use cases
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

// Re-export from the shared protocol package so existing imports keep working.
export { isValidPassword } from "@pizzapi/protocol";

export function normalizePath(value: string): string {
    const trimmed = value.trim().replace(/\\/g, "/");
    return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

/** Check whether a cwd is inside one of the allowed roots. */
/**
 * Lexical root-matching check for cwd validation.
 * This is a pre-filter — the runner daemon performs authoritative symlink-aware
 * validation via realpathSync. The server cannot resolve symlinks because it
 * doesn't have access to the runner's filesystem (may be on a different host).
 */
export function cwdMatchesRoots(roots: string[], cwd: string): boolean {
    // 1. Normalize slashes first
    const nCwd = normalizePath(cwd);

    // 2. Resolve '..' segments using path.posix.normalize
    const resolvedCwd = path.normalize(nCwd);

    // Detect Windows-style paths for case-insensitive comparison
    const isWinPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p);
    const ciCompare = isWinPath(cwd);

    return roots.some((root) => {
        const nRoot = normalizePath(root);
        const resolvedRoot = path.normalize(nRoot);

        // Check if resolvedCwd starts with resolvedRoot
        // Important: Append '/' to ensure we don't match partial folder names
        // e.g. /home/admin matches /home/admin-secret

        // Special-case filesystem root: everything is under "/"
        if (resolvedRoot === "/" || resolvedRoot === "\\") return true;

        // Windows paths are case-insensitive
        const rc = ciCompare ? resolvedCwd.toLowerCase() : resolvedCwd;
        const rr = ciCompare ? resolvedRoot.toLowerCase() : resolvedRoot;

        if (rc === rr) return true;
        return rc.startsWith(rr + "/");
    });
}

/**
 * Strip IPv4-mapped IPv6 prefix (e.g. "::ffff:127.0.0.1" → "127.0.0.1").
 * Node frequently reports IPv4 peers as mapped IPv6 addresses on dual-stack listeners.
 */
function normalizeIp(ip: string): string {
    if (ip.startsWith("::ffff:")) {
        return ip.slice(7);
    }
    return ip;
}

/**
 * Check if an IP address is loopback (indicating a reverse proxy on the same host).
 * Handles IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1) via normalizeIp().
 *
 * SECURITY NOTE: Only loopback is safe for auto-detection. Broader private ranges
 * (10.x, 172.16-31.x, 192.168.x) are NOT auto-trusted by default because the server
 * may be directly accessible on the LAN (e.g. Docker published on 0.0.0.0), where
 * direct clients also arrive with private IPs. Trusting XFF from those would let any
 * LAN client spoof their rate-limit key. Operators behind a non-loopback proxy (e.g.
 * Docker bridge network) should set PIZZAPI_TRUST_PROXY=true explicitly.
 */
function isLoopbackIp(rawIp: string): boolean {
    const ip = normalizeIp(rawIp);
    return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

/**
 * Check if an IP address is loopback or a private/internal range (RFC 1918 / RFC 4193).
 * Used when PIZZAPI_TRUST_PROXY=true to validate that XFF is only trusted from
 * peers that could plausibly be a reverse proxy (not a direct public-internet client).
 *
 * This covers:
 *   - Loopback: 127.x / ::1
 *   - RFC 1918 private: 10.x, 172.16-31.x, 192.168.x (includes Docker bridge IPs)
 *   - Link-local: 169.254.x (IPv4) / fe80:: (IPv6)
 *   - IPv6 unique-local: fc00::/7
 */
function isPrivateOrLoopbackIp(rawIp: string): boolean {
    const ip = normalizeIp(rawIp);
    // Loopback
    if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
    // IPv4 private ranges (RFC 1918)
    if (ip.startsWith("10.")) return true;
    if (ip.startsWith("172.") && /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    if (ip.startsWith("192.168.")) return true;
    // IPv4 link-local
    if (ip.startsWith("169.254.")) return true;
    // IPv6 unique local (fc00::/7)
    if (/^f[cd]/i.test(ip)) return true;
    // IPv6 link-local (fe80::/10)
    if (/^fe[89ab]/i.test(ip)) return true;
    return false;
}

/**
 * Securely extracts the client IP address from a Fetch Request.
 *
 * In direct connections: Uses `x-pizzapi-client-ip` set by the Node.js adapter
 * from the TCP connection's remoteAddress, preventing client spoofing.
 *
 * In reverse proxy setups (common deployment): Detects when remoteAddress is
 * loopback (127.0.0.1 / ::1) and safely trusts `x-forwarded-for` as the real
 * client IP. Only loopback is auto-detected — broader private ranges are not
 * trusted because the server may be directly accessible on the LAN.
 *
 * The `PIZZAPI_TRUST_PROXY` env var can explicitly enable/disable proxy mode:
 * - Set to "true" for any proxy setup, including cloud load balancers with public IPs.
 *   XFF is trusted unconditionally when the operator explicitly opts in. This is the
 *   right setting for cloud load balancers where the peer IP is a public address.
 * - Set to "false" to disable proxy detection entirely (overrides auto-detection)
 */
export function getClientIp(req: Request): string {
    const clientIp = req.headers.get("x-pizzapi-client-ip") || "unknown";
    
    // PIZZAPI_TRUST_PROXY is a three-state toggle:
    //   "true"  → trust x-forwarded-for unconditionally, regardless of peer address.
    //             Use this when the operator has explicitly configured a reverse proxy
    //             (including cloud load balancers with public IPs). The operator's
    //             explicit opt-in is the authorization — no peer-IP check is applied.
    //   "false" → never trust x-forwarded-for, even for loopback (disables auto-detection)
    //   unset   → auto-detect: trust x-forwarded-for only if directly connected to loopback
    const envTrustProxy = process.env.PIZZAPI_TRUST_PROXY?.toLowerCase();
    let trustProxy: boolean;
    if (envTrustProxy === "false") {
        // Explicitly disabled — never trust XFF.
        trustProxy = false;
    } else if (envTrustProxy === "true") {
        // Explicitly enabled — trust XFF only from private/loopback peers.
        // This supports cloud load balancers while preventing IP spoofing
        // if the backend port is accidentally exposed alongside the proxy.
        trustProxy = clientIp !== "unknown" && isPrivateOrLoopbackIp(clientIp);
    } else {
        // Auto-detect (default) — only trust XFF from loopback peers.
        // Private ranges are NOT auto-trusted since the server may be LAN-accessible.
        trustProxy = clientIp !== "unknown" && isLoopbackIp(clientIp);
    }

    if (trustProxy) {
        const forwardedFor = req.headers.get("x-forwarded-for");
        if (forwardedFor) {
            // Use the RIGHT-MOST entry by default. Standard reverse proxies like nginx
            // (with $proxy_add_x_forwarded_for) APPEND $remote_addr to any existing
            // client-supplied X-Forwarded-For header, producing:
            //   X-Forwarded-For: <client-spoofed-value>, <real-client-ip>
            // Taking the left-most value would return the spoofed address. The right-most
            // entry is the one appended by the directly-connected trusted proxy and is
            // safe for single-proxy deployments (the most common case).
            //
            // For multi-proxy chains (e.g. CDN → nginx → PizzaPi), the right-most entry
            // is the intermediate proxy, not the original client. Use PIZZAPI_PROXY_DEPTH
            // to specify how many intermediate proxy hops sit between the peer and the
            // original client (0 = no intermediate hops, i.e. a single proxy; default):
            //   depth=0 (default): single proxy — use right-most entry
            //   depth=1: two proxies (CDN + local) — use second-from-right
            //   depth=N: N+1 total proxies — use entry N positions from the right
            //
            // Fail-closed: require strictly MORE XFF entries than depth.
            // When depth >= parts.length the computed index would land on or before the
            // left-most entry, which a client can freely inject (padding attack): an
            // attacker who knows the configured depth can pad XFF to exactly `depth`
            // entries, making parts.length - depth - 1 equal to a spoofed left-side
            // value. Requiring parts.length > depth ensures at least one
            // proxy-appended entry sits to the right of the selected position.
            // A misconfigured depth (set too high) therefore fails closed to the
            // direct peer IP rather than returning an attacker-controlled value.
            const parts = forwardedFor.split(",").map(s => s.trim()).filter(Boolean);
            const depth = Math.max(0, parseInt(process.env.PIZZAPI_PROXY_DEPTH || "0", 10) || 0);
            if (depth >= parts.length) {
                return clientIp;
            }
            const index = parts.length - 1 - depth;
            return parts[index] || clientIp;
        }
    }

    return clientIp;
}
