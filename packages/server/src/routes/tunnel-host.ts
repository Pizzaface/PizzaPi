/**
 * Host-based tunnel routing — `<label>.<PIZZAPI_TUNNEL_DOMAIN>`.
 *
 * Each tunnel gets an opaque random subdomain label (128-bit hex, Redis-backed,
 * 1h TTL refreshed on use). The hostname is the bearer credential — equivalent
 * strength to the signed tunnel-token URLs — so requests need no cookie or
 * header auth. The relay resolves label → {userId, runner/session, port},
 * re-verifies ownership on every request, and proxies the path VERBATIM over
 * the existing encrypted relay→runner channel. No <base> tag, no interceptor
 * script, no HTML/JS/CSS rewriting — SPA routing and location.pathname just
 * work because the app owns the whole origin.
 *
 * PIZZAPI_TUNNEL_DOMAIN accepts `[scheme://]host[:port]`, e.g.:
 *   - `t.localhost:7492`      (same-machine dev — browsers resolve *.localhost)
 *   - `100-1-2-3.sslip.io`    (tailnet/LAN wildcard DNS)
 *   - `https://t.example.com` (behind Caddy/nginx wildcard TLS)
 *
 * Scheme defaults to http for localhost domains, https otherwise.
 */

import { randomBytes } from "node:crypto";
import { createLogger } from "@pizzapi/tools";
import { connectRedisClient, isRedisDisabled, type RedisClient } from "../redis-client.js";
import { getSession } from "../ws/sio-state/index.js";
import { getTunnelRelay } from "../tunnel-relay.js";
import { assertTunnelTokenStillValid } from "./tunnel-token.js";
import { buildForwardHeaders, proxyTunnelRequestViaRelay, tunnelErrorResponse } from "./tunnel.js";

const log = createLogger("tunnel-host");

const LABEL_TTL_SECONDS = 60 * 60;
const LABEL_KEY_PREFIX = "tunnel-host-label:";
/** Minted labels are 32 lowercase hex chars; accept a small range for future-proofing. */
const LABEL_RE = /^[a-z0-9]{16,64}$/;

const ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

export interface TunnelHostConfig {
    scheme: "http" | "https";
    /** Hostname part only, lowercase (e.g. "t.localhost"). */
    host: string;
    /** ":port" suffix for URL building, or "". */
    portSuffix: string;
}

export interface TunnelLabelRecord {
    userId: string;
    /** Session ID, or "runner:<runnerId>" sentinel (same convention as tunnel tokens). */
    scope: string;
    port: number;
}

// ── Config ──────────────────────────────────────────────────────────────────

export function getTunnelHostConfig(): TunnelHostConfig | null {
    const raw = process.env.PIZZAPI_TUNNEL_DOMAIN?.trim();
    if (!raw) return null;

    let scheme: "http" | "https" | null = null;
    let rest = raw;
    if (rest.startsWith("https://")) { scheme = "https"; rest = rest.slice(8); }
    else if (rest.startsWith("http://")) { scheme = "http"; rest = rest.slice(7); }
    rest = rest.replace(/\/+$/, "");

    const colon = rest.indexOf(":");
    const host = (colon >= 0 ? rest.slice(0, colon) : rest).toLowerCase();
    const portSuffix = colon >= 0 ? rest.slice(colon) : "";
    if (!host || host.includes("/")) return null;

    if (!scheme) {
        scheme = host === "localhost" || host.endsWith(".localhost") ? "http" : "https";
    }

    return { scheme, host, portSuffix };
}

/**
 * Extract the tunnel label from a request hostname, or null when the hostname
 * is not a direct subdomain of the configured tunnel domain. The bare apex and
 * multi-level subdomains are rejected.
 */
export function matchTunnelHost(hostname: string, config: TunnelHostConfig | null = getTunnelHostConfig()): string | null {
    if (!config) return null;
    const lower = hostname.toLowerCase();
    const suffix = `.${config.host}`;
    if (!lower.endsWith(suffix)) return null;
    const label = lower.slice(0, -suffix.length);
    if (!LABEL_RE.test(label)) return null;
    return label;
}

// ── Label store (Redis) ─────────────────────────────────────────────────────

let redis: RedisClient | null = null;
let redisConnecting: Promise<RedisClient | null> | null = null;

export function _injectRedisForTesting(client: RedisClient | null): void {
    redis = client;
    redisConnecting = null;
}

async function getRedis(): Promise<RedisClient | null> {
    if (redis) return redis;
    if (isRedisDisabled()) return null;
    if (!redisConnecting) {
        redisConnecting = connectRedisClient().then((client) => {
            redis = client;
            return client;
        });
    }
    return redisConnecting;
}

/**
 * Mint an opaque tunnel label and return its absolute URL, or null when
 * host-based tunnels are unconfigured or Redis is unavailable.
 */
export async function mintTunnelLabel(record: TunnelLabelRecord): Promise<{ label: string; url: string } | null> {
    const config = getTunnelHostConfig();
    if (!config) return null;
    const client = await getRedis();
    if (!client) return null;

    const label = randomBytes(16).toString("hex");
    try {
        await client.set(`${LABEL_KEY_PREFIX}${label}`, JSON.stringify(record), { EX: LABEL_TTL_SECONDS });
    } catch (err) {
        log.warn("Failed to store tunnel label:", err);
        return null;
    }
    return { label, url: `${config.scheme}://${label}.${config.host}${config.portSuffix}/` };
}

/** Resolve a label to its record, refreshing the TTL on hit. */
export async function resolveTunnelLabel(label: string): Promise<TunnelLabelRecord | null> {
    const client = await getRedis();
    if (!client) return null;
    let raw: string | null;
    try {
        raw = await client.get(`${LABEL_KEY_PREFIX}${label}`);
    } catch (err) {
        log.warn("Failed to resolve tunnel label:", err);
        return null;
    }
    if (!raw) return null;

    let record: TunnelLabelRecord;
    try {
        record = JSON.parse(raw) as TunnelLabelRecord;
    } catch {
        return null;
    }
    if (!record.userId || !record.scope || !Number.isInteger(record.port)) return null;

    // Sliding expiry — active tunnels stay reachable. Fire-and-forget.
    client.expire(`${LABEL_KEY_PREFIX}${label}`, LABEL_TTL_SECONDS).catch(() => undefined);
    return record;
}

/**
 * Resolve + authorize a label all the way to a connected runnerId.
 * Returns an error status when anything fails — shared by HTTP and WS paths.
 */
export async function authorizeTunnelLabel(label: string): Promise<
    | { ok: true; record: TunnelLabelRecord; runnerId: string }
    | { ok: false; status: number; message: string }
> {
    const record = await resolveTunnelLabel(label);
    if (!record) return { ok: false, status: 404, message: "Unknown or expired tunnel" };

    // Authoritative revocation check — same rules as tunnel tokens: session
    // ended, or runner/session owner changed → reject even within the TTL.
    try {
        await assertTunnelTokenStillValid({ v: 1, userId: record.userId, sessionId: record.scope, port: record.port, exp: 0 });
    } catch {
        return { ok: false, status: 401, message: "Tunnel revoked" };
    }

    let runnerId: string | null;
    if (record.scope.startsWith("runner:")) {
        runnerId = record.scope.slice("runner:".length);
    } else {
        const sessionData = await getSession(record.scope);
        runnerId = sessionData?.runnerId ?? null;
    }
    if (!runnerId) return { ok: false, status: 503, message: "Session has no runner" };

    return { ok: true, record, runnerId };
}

// ── HTTP handler ────────────────────────────────────────────────────────────

/**
 * Handle a request addressed to `<label>.<tunnel domain>`. Returns undefined
 * when host-based tunnels are unconfigured or the hostname doesn't match, so
 * the caller falls through to normal routing.
 *
 * Must run BEFORE the body-size guard (bodies stream to the runner) and the
 * CSRF origin gate (label-authenticated, not cookie-authenticated).
 */
export async function handleTunnelHostRequest(req: Request, url: URL): Promise<Response | undefined> {
    const config = getTunnelHostConfig();
    if (!config) return undefined;
    const label = matchTunnelHost(url.hostname, config);
    if (!label) return undefined;

    const method = req.method.toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) {
        return new Response("Method not allowed", { status: 405, headers: { Allow: ALLOWED_METHODS.join(", ") } });
    }

    const auth = await authorizeTunnelLabel(label);
    if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

    const relay = getTunnelRelay();
    if (!relay?.hasRunner(auth.runnerId)) {
        return tunnelErrorResponse(`Runner ${auth.runnerId} not connected`);
    }

    // Forward the path verbatim — the app owns the whole origin.
    const pathWithQuery = `${url.pathname}${url.search}`;
    const forwardHeaders = buildForwardHeaders(req);
    // Help well-behaved apps generate correct absolute URLs.
    forwardHeaders["x-forwarded-host"] = url.host;
    forwardHeaders["x-forwarded-proto"] = config.scheme;

    const requestId = `host-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // basePath "" → passthrough mode: no buffering, no rewriting, no injection.
    return proxyTunnelRequestViaRelay(
        req,
        relay,
        auth.runnerId,
        requestId,
        "",
        auth.record.port,
        url.pathname,
        pathWithQuery,
        forwardHeaders,
        true,
    );
}
