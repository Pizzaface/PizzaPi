import * as React from "react";
import { getMobileRuntimeConfig } from "@/lib/mobile-runtime";
import { logFrontendEvent } from "@/lib/frontend-log";

/**
 * Socket endpoint + auth configuration.
 *
 * Capacitor bundled mode: sockets need an absolute server URL and the API key
 * injected by the bootstrap page, because the webview origin is local.
 */
export function useSocketConfig(isPending: boolean) {
  const { isMobileBundled, serverUrl, apiKey } = getMobileRuntimeConfig();
  const socketBaseUrl = isMobileBundled && serverUrl ? serverUrl.replace(/\/+$/, "") : null;

  // Diagnostic breadcrumb: if auth stays "pending" for a long time on mobile
  // (dark bg + tiny spinner reads as a blank screen), log it so the Logs
  // overlay shows *something* instead of the user staring at nothing.
  React.useEffect(() => {
    if (!isMobileBundled || !isPending) return;
    const t = setTimeout(() => {
      logFrontendEvent(
        "auth",
        "warning",
        "Still resolving session after 8s",
        `serverUrl=${serverUrl ?? "(none)"} hasApiKey=${!!apiKey}`,
      );
    }, 8000);
    return () => clearTimeout(t);
  }, [isMobileBundled, isPending, serverUrl, apiKey]);
  const socketUrl = React.useCallback(
    (namespace: string) => (socketBaseUrl ? `${socketBaseUrl}${namespace}` : namespace),
    [socketBaseUrl],
  );
  const buildSocketAuth = React.useCallback(
    (extra: Record<string, unknown>) => ({ ...extra, ...(apiKey ? { apiKey } : {}) }),
    [apiKey],
  );

  return { isMobileBundled, socketUrl, buildSocketAuth };
}
