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
 * (10.x, 172.16-31.x, 192.168.x) are NOT auto-trusted because the server may be
 * directly accessible on the LAN (e.g. Docker published on 0.0.0.0), where direct
 * clients also arrive with private IPs. Trusting XFF from those would let any LAN
 * client spoof their rate-limit key. Operators behind a non-loopback proxy (e.g.
 * Docker bridge network) should set PIZZAPI_TRUST_PROXY=true explicitly.
 */
function isLoopbackIp(rawIp: string): boolean {
    const ip = normalizeIp(rawIp);
    return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
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
 * - Set to "true" for non-loopback proxies (e.g. Docker bridge networks)
 * - Set to "false" to disable proxy detection entirely (overrides auto-detection)
 */
export function getClientIp(req: Request): string {
    const clientIp = req.headers.get("x-pizzapi-client-ip") || "unknown";
    
    // PIZZAPI_TRUST_PROXY is a three-state toggle:
    //   "true"  → always trust x-forwarded-for (for non-loopback proxies like Docker bridge)
    //   "false" → never trust x-forwarded-for, even for loopback (disables auto-detection)
    //   unset   → auto-detect: trust x-forwarded-for only if directly connected to loopback
    const envTrustProxy = process.env.PIZZAPI_TRUST_PROXY?.toLowerCase();
    const trustProxy =
        envTrustProxy === "true" ||
        (envTrustProxy !== "false" && clientIp !== "unknown" && isLoopbackIp(clientIp));
    // Note: If envTrustProxy === "false", the second condition is skipped and trustProxy stays false.

    if (trustProxy) {
        const forwardedFor = req.headers.get("x-forwarded-for");
        if (forwardedFor) {
            // Use the LEFT-MOST entry (the original client IP). Standard reverse proxies
            // (nginx, Caddy, etc.) prepend the real client IP to the X-Forwarded-For
            // header on first connection, and then append their own IP on subsequent
            // connections in a chain. The format in single-proxy setups is:
            //   X-Forwarded-For: <original-client-ip>
            // Or in multi-proxy setups:
            //   X-Forwarded-For: <original-client-ip>, <first-proxy>, <second-proxy>, ...
            // Taking the left-most value is safe when we trust the directly-connected
            // proxy, because the proxy never appends a client-supplied X-Forwarded-For;
            // it creates a fresh one with the real client.
            const parts = forwardedFor.split(",");
            return parts[0]?.trim() || clientIp;
        }
    }

    return clientIp;
}
