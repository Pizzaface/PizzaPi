export interface SafeFetchOptions extends Omit<RequestInit, "signal"> {
  timeout?: number;
  silent?: boolean;
  operation?: string;
}

export async function safeFetch(url: string, options?: SafeFetchOptions): Promise<Response | null> {
  const { timeout = 30000, silent = false, operation, ...fetchOptions } = options ?? {};
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const logMessage = operation ? `[safeFetch] ${operation} failed: ${url} (${response.status})` : `[safeFetch] Request failed: ${url} (${response.status})`;
      if (silent) console.debug(logMessage);
      else console.warn(logMessage);
      return null;
    }
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    const isAbort = err instanceof Error && err.name === "AbortError";
    const errorType = isAbort ? "timeout" : "error";
    const logMessage = operation ? `[safeFetch] ${operation} ${errorType}: ${url}` : `[safeFetch] Request ${errorType}: ${url}`;
    if (silent) console.debug(logMessage, err);
    else console.error(logMessage, err);
    return null;
  }
}

export function fireAndForget(url: string, options?: SafeFetchOptions): void {
  void safeFetch(url, { ...options, silent: true });
}

export async function safeFetchJson<T>(url: string, options?: SafeFetchOptions): Promise<T | null> {
  const response = await safeFetch(url, options);
  if (!response) return null;
  try {
    return (await response.json()) as T;
  } catch (err) {
    console.error(`[safeFetch] ${options?.operation ?? "JSON parse"} failed for ${url}:`, err);
    return null;
  }
}

export default safeFetch;
