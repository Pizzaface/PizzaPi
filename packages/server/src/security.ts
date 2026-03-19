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
 * Check if an IP address is private/loopback (indicating likely reverse proxy setup).
 * Handles IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1) via normalizeIp().
 */
function isPrivateOrLoopbackIp(rawIp: string): boolean {
    const ip = normalizeIp(rawIp);
    // Loopback
    if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
    // IPv4 private ranges
    if (ip.startsWith("10.")) return true;
    if (ip.startsWith("172.") && /^172\.([1-2][0-9]|3[0-1])\./.test(ip)) return true;
    if (ip.startsWith("192.168.")) return true;
    // IPv4 link-local
    if (ip.startsWith("169.254.")) return true;
    // IPv6 unique local
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
    // IPv6 link-local
    if (ip.startsWith("fe80")) return true;
    return false;
}

/**
 * Securely extracts the client IP address from a Fetch Request.
 *
 * In direct connections: Uses `x-pizzapi-client-ip` set by the Node.js adapter
 * from the TCP connection's remoteAddress, preventing client spoofing.
 *
 * In reverse proxy setups (common deployment): Detects when remoteAddress is
 * a private/loopback IP and safely trusts `x-forwarded-for` as the real client IP.
 *
 * The `PIZZAPI_TRUST_PROXY` env var can explicitly enable/disable proxy mode
 * for advanced setups (e.g. proxies that don't preserve loopback addresses).
 */
export function getClientIp(req: Request): string {
    const clientIp = req.headers.get("x-pizzapi-client-ip") || "unknown";
    
    // PIZZAPI_TRUST_PROXY is a three-state toggle:
    //   "true"  → always trust x-forwarded-for
    //   "false" → never trust x-forwarded-for (disables auto-detection)
    //   unset   → auto-detect based on whether remoteAddress is private/loopback
    const envTrustProxy = process.env.PIZZAPI_TRUST_PROXY?.toLowerCase();
    const trustProxy =
        envTrustProxy === "true" ||
        (envTrustProxy !== "false" && clientIp !== "unknown" && isPrivateOrLoopbackIp(clientIp));

    if (trustProxy) {
        const forwardedFor = req.headers.get("x-forwarded-for");
        if (forwardedFor) {
            return forwardedFor.split(",")[0]?.trim() || clientIp;
        }
    }

    return clientIp;
}
