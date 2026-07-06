import { posix as path } from "path";

import { incrementRateLimitCounter, getRateLimitWindow } from "./redis-kv-store.js";

/**
 * Rate limiter with an optional Redis-backed counter path.
 *
 * The public interface (`check(key)` / `getRetryAfter(key)`) remains
 * synchronous so existing callers do not need to change. The in-memory Map
 * is the authoritative source of truth for each process; Redis is used as a
 * shared backing store and is kept in sync via write-through on every allowed
 * hit and a periodic background sync.
 *
 * When Redis is disabled or unavailable, the limiter falls back to the
 * previous per-process Map behavior. Because `check()` is synchronous, there
 * is a small bounded window (the sync interval) during which a request that
 * lands on a different node may not see the latest cross-node count. The
 * in-memory path prevents cross-node coordination latency from blocking the
 * hot path.
 */
export class RateLimiter {
    private hits = new Map<string, { count: number; resetTime: number }>();
    private knownKeys = new Set<string>();
    private cleanupInterval: ReturnType<typeof setInterval>;
    private redisSyncInterval?: ReturnType<typeof setInterval>;

    /**
     * @param limit Max requests per window
     * @param windowMs Time window in milliseconds
     * @param redisSyncMs How often to refresh the in-memory Map from Redis
     *                    (default 5000ms). Only used when Redis is available.
     */
    constructor(
        private limit: number,
        private windowMs: number,
        private redisSyncMs: number = 5_000,
    ) {
        // Clean up expired entries every minute to prevent memory leaks
        this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
        // Ensure cleanup stops if the process exits (though for a long-running server this isn't strictly necessary)
        if (typeof this.cleanupInterval === 'object' && 'unref' in this.cleanupInterval) {
            (this.cleanupInterval as any).unref();
        }

        // Background sync from Redis keeps cross-node counts visible within
        // one sync interval. The in-memory Map remains authoritative so that
        // check() stays synchronous.
        if (this.redisSyncMs > 0) {
            this.redisSyncInterval = setInterval(() => this.syncFromRedis(), this.redisSyncMs);
            if (typeof this.redisSyncInterval === 'object' && 'unref' in this.redisSyncInterval) {
                (this.redisSyncInterval as any).unref();
            }
        }
    }

    /**
     * Checks if a request from the given key is allowed.
     * @param key Unique identifier (e.g., IP address or user ID)
     * @returns true if allowed, false if limit exceeded
     */
    check(key: string): boolean {
        this.knownKeys.add(key);
        const now = Date.now();
        const record = this.hits.get(key);

        if (!record || now > record.resetTime) {
            this.hits.set(key, { count: 1, resetTime: now + this.windowMs });
            this.writeThroughToRedis(key);
            return true;
        }

        if (record.count >= this.limit) {
            return false;
        }

        record.count++;
        this.writeThroughToRedis(key);
        return true;
    }

    private writeThroughToRedis(key: string): void {
        // Fire-and-forget: latency of the Redis round-trip must not block
        // the synchronous check() interface.
        incrementRateLimitCounter(key, this.windowMs).catch(() => {});
    }

    private async syncFromRedis(): Promise<void> {
        const keys = [...this.knownKeys];
        const windows = await Promise.all(
            keys.map(async (key) => ({ key, window: await getRateLimitWindow(key) })),
        );
        const now = Date.now();
        for (const { key, window } of windows) {
            if (!window) continue;
            const record = this.hits.get(key);
            // Adopt the Redis window when it has a higher count or when our
            // local window has expired. This prevents long-running nodes from
            // falling behind the cluster-wide counter.
            if (!record || now > record.resetTime || window.count > record.count) {
                this.hits.set(key, window);
            }
        }
    }

    /**
     * Returns the number of seconds until the rate limit window resets for the given key.
     * Call this after check() returns false to populate the Retry-After response header.
     * Returns the full window duration (in seconds) if no active window is found.
     *
     * **Boundary note:** `check()` treats `now === resetTime` as still in-window and
     * returns false (rate-limited). At that exact millisecond `resetTime - now === 0`,
     * so a naive `Math.ceil(0 / 1000)` would produce 0 — causing a `Retry-After: 0`
     * header that drives clients into an immediate retry storm. We clamp to a minimum
     * of 1 second so every `429` always carries a non-zero retry interval.
     */
    getRetryAfter(key: string): number {
        const now = Date.now();
        const record = this.hits.get(key);
        if (!record || now > record.resetTime) {
            // Dead code in production: callers only invoke getRetryAfter() after
            // check() has returned false, which guarantees an active (non-expired)
            // record exists for this key. This branch exists as a safe fallback for
            // direct / test usage where that invariant isn't enforced.
            return Math.ceil(this.windowMs / 1000);
        }
        // Math.max(1, ...) prevents Retry-After: 0 at the window-expiry boundary
        // (when now === resetTime, resetTime - now is 0, but check() still said no).
        return Math.max(1, Math.ceil((record.resetTime - now) / 1000));
    }

    private cleanup() {
        const now = Date.now();
        for (const [key, record] of this.hits.entries()) {
            if (now > record.resetTime) {
                this.hits.delete(key);
                this.knownKeys.delete(key);
            }
        }
    }

    // For testing purposes
    destroy() {
        clearInterval(this.cleanupInterval);
        if (this.redisSyncInterval) clearInterval(this.redisSyncInterval);
    }
}

// Module-level encoder avoids a new allocation on every isValidEmail call.
const _emailEncoder = new TextEncoder();

export function isValidEmail(email: string): boolean {
    const encoder = _emailEncoder;

    // RFC 5321: total email address path limit is 254 bytes (measured in UTF-8 bytes,
    // not JavaScript UTF-16 code units, to correctly handle non-ASCII characters).
    if (encoder.encode(email).length > 254) {
        return false;
    }

    // Split on the last '@' to separate local part from domain.
    const atIndex = email.lastIndexOf("@");
    if (atIndex <= 0 || atIndex === email.length - 1) {
        // No '@', empty local part (@ at position 0), or empty domain (@ at end).
        return false;
    }

    const localPart = email.slice(0, atIndex);
    const domain = email.slice(atIndex + 1);

    // Local part must not contain whitespace or a second '@'.
    if (/[\s@]/.test(localPart)) return false;

    // RFC 5321: local part must be ≤ 64 bytes (UTF-8 bytes, not character count).
    // A multibyte character (e.g. 'é' = 2 bytes) can allow a local part that passes
    // a character-count check but exceeds the RFC byte limit.
    if (encoder.encode(localPart).length > 64) return false;

    // Domain must not contain whitespace or '@'.
    if (/[\s@]/.test(domain)) return false;

    // Reject consecutive dots (e.g. "a@..example.com", "a@example..com").
    if (domain.includes("..")) return false;

    // Reject leading or trailing dots (e.g. "a@.example.com", "a@example.com.").
    if (domain.startsWith(".") || domain.endsWith(".")) return false;

    // Validate DNS structure: domain total ≤ 253 chars, each label 1–63 chars,
    // only [a-zA-Z0-9-], no leading/trailing hyphen per label, TLD ≥ 2 chars.
    if (domain.length > 253) return false;
    const labels = domain.split(".");
    if (labels.length < 2) return false;
    // Each label must start and end with an alphanumeric character; hyphens are
    // only permitted in interior positions (RFC 1035 §2.3.4).
    const labelRe = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
    for (const label of labels) {
        if (label.length < 1 || label.length > 63) return false;
        if (!labelRe.test(label)) return false;
    }
    // TLD must be at least 2 characters.
    return labels[labels.length - 1].length >= 2;
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
    return ip.startsWith("127.") || ip === "::1" || ip === "localhost";
}

/**
 * Parse an IPv4 address into a 4-byte Uint8Array. Returns null if invalid.
 */
function parseIpv4(ip: string): Uint8Array | null {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!m) return null;
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
        const n = Number(m[i + 1]);
        if (n > 255) return null;
        out[i] = n;
    }
    return out;
}

/**
 * Parse an IPv6 address (including :: compression and IPv4-mapped form like ::ffff:1.2.3.4)
 * into a 16-byte Uint8Array. Returns null if invalid.
 */
function parseIpv6(ip: string): Uint8Array | null {
    // IPv4-embedded form (e.g. ::ffff:1.2.3.4). Convert the dotted-quad tail to two
    // hex groups so the rest of the parser doesn't need a special case.
    if (ip.includes(".")) {
        const lastColon = ip.lastIndexOf(":");
        if (lastColon === -1) return null;
        const v4 = parseIpv4(ip.slice(lastColon + 1));
        if (!v4) return null;
        const g1 = (((v4[0] << 8) | v4[1]) >>> 0).toString(16);
        const g2 = (((v4[2] << 8) | v4[3]) >>> 0).toString(16);
        ip = ip.slice(0, lastColon + 1) + g1 + ":" + g2;
    }
    const halves = ip.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const fillCount = 8 - left.length - right.length;
    if (halves.length === 1) {
        if (left.length !== 8) return null;
    } else {
        if (fillCount < 0) return null;
    }
    const groups = halves.length === 1
        ? left
        : [...left, ...Array(fillCount).fill("0"), ...right];
    const out = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
        const g = groups[i];
        if (!g || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g)) return null;
        const n = parseInt(g, 16);
        out[i * 2] = (n >> 8) & 0xff;
        out[i * 2 + 1] = n & 0xff;
    }
    return out;
}

interface ParsedCidr {
    family: 4 | 6;
    bytes: Uint8Array;
    prefix: number;
}

function parseCidr(cidr: string): ParsedCidr | null {
    const s = cidr.trim();
    if (!s) return null;
    const slash = s.indexOf("/");
    const ipStr = slash === -1 ? s : s.slice(0, slash);
    const v4 = parseIpv4(ipStr);
    if (v4) {
        const prefix = slash === -1 ? 32 : Number(s.slice(slash + 1));
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
        return { family: 4, bytes: v4, prefix };
    }
    const v6 = parseIpv6(ipStr);
    if (v6) {
        const prefix = slash === -1 ? 128 : Number(s.slice(slash + 1));
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
        return { family: 6, bytes: v6, prefix };
    }
    return null;
}

function matchPrefix(a: Uint8Array, b: Uint8Array, prefix: number): boolean {
    const fullBytes = prefix >> 3;
    const remBits = prefix & 7;
    for (let i = 0; i < fullBytes; i++) {
        if (a[i] !== b[i]) return false;
    }
    if (remBits === 0) return true;
    const mask = (0xff << (8 - remBits)) & 0xff;
    return (a[fullBytes] & mask) === (b[fullBytes] & mask);
}

// Cache parsed CIDRs keyed on the raw env string so we re-parse only when the
// env var changes (which in practice means at server start, but tests mutate it).
let _trustedProxyCidrCache: { raw: string | undefined; parsed: ParsedCidr[] } | null = null;
let _warnedInvalidCidrs = new Set<string>();

/**
 * Parse PIZZAPI_TRUSTED_PROXY_CIDRS — a comma-separated list of CIDR ranges
 * (IPv4 or IPv6) whose peers are trusted to set X-Forwarded-For.
 *
 * Invalid entries are skipped and logged once. Returns an empty array when
 * the env var is unset or empty.
 */
function getTrustedProxyCidrs(): ParsedCidr[] {
    const raw = process.env.PIZZAPI_TRUSTED_PROXY_CIDRS;
    if (_trustedProxyCidrCache && _trustedProxyCidrCache.raw === raw) {
        return _trustedProxyCidrCache.parsed;
    }
    const parsed: ParsedCidr[] = [];
    if (raw) {
        for (const part of raw.split(",")) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const cidr = parseCidr(trimmed);
            if (cidr) {
                parsed.push(cidr);
            } else if (!_warnedInvalidCidrs.has(trimmed)) {
                _warnedInvalidCidrs.add(trimmed);
                console.warn(`[security] Ignoring invalid CIDR in PIZZAPI_TRUSTED_PROXY_CIDRS: ${trimmed}`);
            }
        }
    }
    _trustedProxyCidrCache = { raw, parsed };
    return parsed;
}

/**
 * Returns true if the given peer IP is in PIZZAPI_TRUSTED_PROXY_CIDRS.
 * Handles IPv4-mapped IPv6 (::ffff:1.2.3.4) by normalizing first.
 */
function isTrustedProxyByCidr(rawIp: string): boolean {
    const cidrs = getTrustedProxyCidrs();
    if (cidrs.length === 0) return false;
    const ip = normalizeIp(rawIp);
    const v4 = parseIpv4(ip);
    const bytes = v4 ?? parseIpv6(ip);
    if (!bytes) return false;
    const family: 4 | 6 = v4 ? 4 : 6;
    for (const cidr of cidrs) {
        if (cidr.family !== family) continue;
        if (matchPrefix(bytes, cidr.bytes, cidr.prefix)) return true;
    }
    return false;
}

// Test-only: reset CIDR cache so tests can mutate the env var between cases.
export function _resetTrustedProxyCidrCacheForTests(): void {
    _trustedProxyCidrCache = null;
    _warnedInvalidCidrs = new Set();
}

/**
 * Check if an IP address is loopback or a private/internal range (RFC 1918 / RFC 4193).
 * Used when PIZZAPI_TRUST_PROXY=true (without a CIDR allowlist) to validate that XFF
 * is only trusted from peers that could plausibly be a reverse proxy.
 *
 * This covers:
 *   - Loopback: 127.x / ::1
 *   - RFC 1918 private: 10.x, 172.16-31.x, 192.168.x (includes Docker bridge IPs)
 *   - Link-local: 169.254.x (IPv4) / fe80:: (IPv6)
 *   - IPv6 unique-local: fc00::/7
 */
function isPrivateOrLoopbackIp(rawIp: string): boolean {
    const ip = normalizeIp(rawIp);
    // Loopback (127.0.0.0/8)
    if (ip.startsWith("127.") || ip === "::1" || ip === "localhost") return true;
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
 * Trust resolution (highest precedence first):
 * - `PIZZAPI_TRUST_PROXY=false`: never trust XFF, even from loopback. Overrides everything.
 * - `PIZZAPI_TRUSTED_PROXY_CIDRS` set: trust XFF only when the peer IP falls inside one of
 *   the listed CIDR ranges (loopback is always also trusted). This is the recommended
 *   setting for cloud load balancers (public peer IPs), shared LANs/VPCs, and any
 *   deployment where the proxy's IP is known and stable.
 * - `PIZZAPI_TRUST_PROXY=true`: trust XFF from any loopback or RFC1918/ULA private peer.
 *   Convenience setting for single-tenant Docker Compose deployments. Do NOT use on
 *   shared LANs/VPCs where untrusted hosts share the private network — they can spoof.
 * - unset (default): auto-detect — trust XFF only from a loopback peer.
 */
export function getClientIp(req: Request): string {
    const clientIp = req.headers.get("x-pizzapi-client-ip") || "unknown";

    const envTrustProxy = process.env.PIZZAPI_TRUST_PROXY?.toLowerCase();
    const cidrs = getTrustedProxyCidrs();
    let trustProxy: boolean;
    if (envTrustProxy === "false") {
        // Explicit kill switch — never trust XFF.
        trustProxy = false;
    } else if (cidrs.length > 0) {
        // Explicit allowlist — trust XFF iff peer is loopback or in an allowed CIDR.
        // Loopback is always safe to trust and saves operators from having to enumerate it.
        trustProxy = clientIp !== "unknown"
            && (isLoopbackIp(clientIp) || isTrustedProxyByCidr(clientIp));
    } else if (envTrustProxy === "true") {
        // Legacy opt-in: trust XFF from any private/loopback peer. Suitable for
        // single-tenant Docker Compose but NOT for shared LANs/VPCs (use CIDR allowlist there).
        trustProxy = clientIp !== "unknown" && isPrivateOrLoopbackIp(clientIp);
    } else {
        // Auto-detect (default) — only trust XFF from loopback peers.
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
            // Fail-closed behavior:
            // - If the chain is shorter than configured depth, we cannot safely resolve
            //   the client hop and fall back to the direct peer IP.
            // - Extra left-side entries (client-prepended padding) are tolerated for all
            //   depth values — the formula reads from the right, so padding on the left
            //   cannot shift the trusted proxy entries or spoof the client slot.
            const parts = forwardedFor.split(",").map(s => s.trim()).filter(Boolean);
            const depth = Math.max(0, parseInt(process.env.PIZZAPI_PROXY_DEPTH || "0", 10) || 0);
            const expectedEntries = depth + 1;

            // Fail closed when the chain doesn't match expected topology.
            //
            // We fall back to the raw socket/proxy IP (clientIp) rather than "unknown".
            // Returning "unknown" would either (a) cause callers to skip rate limiting
            // entirely — re-enabling brute-force bypass, or (b) collapse all affected
            // requests into a single shared rate-limit bucket, letting one attacker 429
            // every user whose XFF resolution also failed.
            //
            // Using clientIp (the proxy's address) means users behind the same proxy
            // share a rate-limit bucket, but that's bounded to one proxy's user base
            // and still enforces throttling — a strictly better outcome than no limiting.
            if (parts.length < expectedEntries) {
                return clientIp;
            }

            // We do NOT require an exact chain length match — extra left-side entries
            // are harmless for any depth value, including depth>0.
            //
            // Each trusted proxy APPENDS its peer's IP to the right of the XFF chain.
            // So the rightmost `depth` entries are always the known trusted proxy IPs,
            // and the entry at `parts[parts.length - 1 - depth]` is always the one
            // recorded by the outermost trusted proxy (the CDN) — which is the real
            // client IP regardless of how many bogus entries the client prepended on
            // the left side.
            //
            // Example with depth=1 (CDN → local proxy → server):
            //   Legitimate:   <client-ip>, <cdn-ip>        → index = 0 ✓
            //   Padded:       <bogus>, <client-ip>, <cdn-ip> → index = 1 ✓
            // The padded chain still yields the correct client IP.
            //
            // depth=0 remains tolerant of additional left-side entries for the same
            // reason: the right-most entry is always the directly-connected proxy's
            // append and is safe to use.

            const index = parts.length - 1 - depth;
            return parts[index] || clientIp;
        }
    }

    return clientIp;
}
