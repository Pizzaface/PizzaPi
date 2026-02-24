/**
 * Redis key namespacing for multi-tenant (org-scoped) deployments.
 *
 * When `REDIS_PREFIX` env var is set, all Redis keys are prefixed with it.
 * Format: `org:{slug}:` (e.g., `org:acme:session:123`).
 *
 * When unset/empty, keys are unchanged (backward compatible).
 */

const _prefix = (process.env.REDIS_PREFIX ?? "").trim();

/**
 * Prefix a Redis key with the org namespace.
 * If `REDIS_PREFIX` is empty/unset, returns the key unchanged.
 */
export function redisKey(k: string): string {
    return _prefix ? `${_prefix}:${k}` : k;
}

/** Returns the raw prefix value (empty string if unset). */
export function getRedisPrefix(): string {
    return _prefix;
}
