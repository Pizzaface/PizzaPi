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
export function cwdMatchesRoots(roots: string[], cwd: string): boolean {
    // 1. Normalize slashes first
    const nCwd = normalizePath(cwd);

    // 2. Resolve '..' segments using path.posix.normalize
    const resolvedCwd = path.normalize(nCwd);

    return roots.some((root) => {
        const nRoot = normalizePath(root);
        const resolvedRoot = path.normalize(nRoot);

        // Check if resolvedCwd starts with resolvedRoot
        // Important: Append '/' to ensure we don't match partial folder names
        // e.g. /home/admin matches /home/admin-secret

        if (resolvedCwd === resolvedRoot) return true;
        return resolvedCwd.startsWith(resolvedRoot + "/");
    });
}

/**
 * Safely extracts the client IP from a Request object.
 * It uses the x-pizzapi-client-ip header (set by our http server) which represents the
 * direct network connection.
 * If the connection comes from a trusted local proxy (e.g. 127.0.0.1, ::1, or private ranges),
 * it optionally respects the X-Forwarded-For header if present.
 */
export function getClientIp(req: Request): string {
    const directIp = req.headers.get("x-pizzapi-client-ip") || "unknown";

    // Define trusted proxy IPs/ranges here. For now, we trust local loopbacks.
    const isTrustedProxy = directIp === "127.0.0.1" || directIp === "::1" || directIp === "::ffff:127.0.0.1";

    if (isTrustedProxy) {
        const xff = req.headers.get("x-forwarded-for");
        if (xff) {
            return xff.split(",")[0].trim();
        }
    }

    return directIp;
}
