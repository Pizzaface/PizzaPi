/**
 * Extract the OAuth `code` parameter from a pasted callback URL.
 * Accepts full URLs (http://localhost:1/callback?code=ABC&state=XYZ)
 * or just query strings (?code=ABC&state=XYZ).
 */
export function extractCodeFromUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    // Try parsing as a full URL first
    const url = new URL(trimmed);
    return url.searchParams.get("code");
  } catch {
    // Not a valid URL — try as a query string
    if (trimmed.includes("code=")) {
      const params = new URLSearchParams(
        trimmed.startsWith("?") ? trimmed : `?${trimmed}`,
      );
      return params.get("code");
    }
    return null;
  }
}
