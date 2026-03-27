// ============================================================================
// Shared versioning + compatibility helpers
// ============================================================================

/**
 * Socket handshake protocol version.
 *
 * Bump this when Socket.IO handshake semantics or required auth payload fields
 * become incompatible with previous clients.
 */
export const SOCKET_PROTOCOL_VERSION = 1;

/**
 * Parse a semver-like version string (`1.2.3`, `v1.2.3`, `1.2.3-beta.1`).
 * Returns `[major, minor, patch]` or `null` when parsing fails.
 */
export function parseSemverTriplet(version: string): [number, number, number] | null {
  const normalized = version.trim().replace(/^v/i, "");
  if (!normalized) return null;

  // Ignore pre-release / build metadata for ordering decisions.
  const base = normalized.split("-")[0]?.split("+")[0] ?? "";
  const parts = base.split(".");
  if (parts.length < 1 || parts.length > 3) return null;

  const rawMajor = parts[0] ?? "";
  const rawMinor = parts[1] ?? "0";
  const rawPatch = parts[2] ?? "0";

  if (!/^\d+$/.test(rawMajor) || !/^\d+$/.test(rawMinor) || !/^\d+$/.test(rawPatch)) {
    return null;
  }

  const major = Number(rawMajor);
  const minor = Number(rawMinor);
  const patch = Number(rawPatch);

  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }
  if (major < 0 || minor < 0 || patch < 0) return null;

  return [major, minor, patch];
}

/**
 * Compare two semver-like version strings.
 *
 * Returns:
 * - `1` when `a > b`
 * - `0` when `a == b`
 * - `-1` when `a < b`
 *
 * Invalid versions compare as equal (`0`) so callers can degrade gracefully.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemverTriplet(a);
  const pb = parseSemverTriplet(b);
  if (!pa || !pb) return 0;

  for (let i = 0; i < 3; i++) {
    if (pa[i]! > pb[i]!) return 1;
    if (pa[i]! < pb[i]!) return -1;
  }
  return 0;
}

/**
 * Socket protocol compatibility check.
 * Missing/invalid client versions are treated as compatible so older clients
 * can still connect and display a friendly update banner instead of hard fail.
 */
export function isSocketProtocolCompatible(clientProtocolVersion: unknown): boolean {
  if (typeof clientProtocolVersion !== "number" || !Number.isInteger(clientProtocolVersion)) {
    return true;
  }
  return clientProtocolVersion === SOCKET_PROTOCOL_VERSION;
}
