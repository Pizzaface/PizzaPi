/**
 * Extract the OAuth `code` parameter from a pasted callback URL.
 * Accepts full URLs (http://localhost:1/callback?code=ABC&state=XYZ)
 * or just query strings (?code=ABC&state=XYZ).
 */
export function extractCodeFromUrl(input: string): string | null {
  return extractOAuthParams(input).code;
}

/**
 * Extract both `code` and `state` from a pasted OAuth callback URL.
 * Returns { code, state } — either may be null if not found.
 */
export function extractOAuthParams(input: string): { code: string | null; state: string | null } {
  const trimmed = input.trim();
  if (!trimmed) return { code: null, state: null };

  try {
    const url = new URL(trimmed);
    return {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
    };
  } catch {
    if (trimmed.includes("code=")) {
      const params = new URLSearchParams(
        trimmed.startsWith("?") ? trimmed : `?${trimmed}`,
      );
      return {
        code: params.get("code"),
        state: params.get("state"),
      };
    }
    return { code: null, state: null };
  }
}
