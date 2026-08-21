/**
 * Parse a cold-start pathname for the canonical session deep-link route.
 * Returns the decoded session ID if the pathname matches `/session/<id>`,
 * otherwise null.
 */
export function parseSessionDeepLink(pathname: string): string | null {
  const m = pathname.match(/^\/session\/([^/]+)(?:\/|$)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
