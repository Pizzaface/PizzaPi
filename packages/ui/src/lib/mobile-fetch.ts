/**
 * Global fetch patch for the bundled Capacitor app.
 *
 * When running from mobile/app/index.html the UI's origin is capacitor://localhost
 * (iOS) or https://localhost (Android), so relative paths would resolve to the
 * local bundle rather than the relay server. This patch:
 *   - prepends the configured server URL to relative paths
 *   - adds the x-api-key header when an API key is stored
 *
 * It only applies when localStorage contains `pizzapi.serverUrl`, so the
 * standard web build (served from the server, same-origin) is untouched.
 */
import { getMobileRuntimeConfig, resolveMobileUrl } from "./mobile-runtime.js";

const ORIGINAL_FETCH = window.fetch.bind(window);

function patchHeaders(init?: RequestInit): RequestInit | undefined {
    const { apiKey } = getMobileRuntimeConfig();
    if (!apiKey) return init;
    const headers = new Headers(init?.headers);
    if (!headers.has("x-api-key")) {
        headers.set("x-api-key", apiKey);
    }
    return { ...init, headers };
}

function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const { isMobileBundled } = getMobileRuntimeConfig();
    if (!isMobileBundled) {
        return ORIGINAL_FETCH(input, init);
    }

    let url: string;
    if (input instanceof Request) {
        url = resolveMobileUrl(input.url);
        const nextInit = patchHeaders({ ...input, ...init });
        return ORIGINAL_FETCH(url, nextInit);
    }
    if (typeof input === "string") {
        url = resolveMobileUrl(input);
    } else {
        url = resolveMobileUrl(input.toString());
    }
    return ORIGINAL_FETCH(url, patchHeaders(init));
}

/** Install the fetch patch. Safe to call multiple times. */
export function installMobileFetchPatch(): void {
    const { isMobileBundled } = getMobileRuntimeConfig();
    if (!isMobileBundled) return;
    if (window.fetch === patchedFetch) return;
    window.fetch = patchedFetch as typeof window.fetch;
}
