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

/**
 * True when the resolved URL targets the configured relay server (same origin).
 * The api key must never leak to third-party absolute URLs — relative paths are
 * rewritten to serverUrl by resolveMobileUrl, so they pass; cross-origin URLs do not.
 */
function targetsServer(resolvedUrl: string): boolean {
    const { serverUrl } = getMobileRuntimeConfig();
    if (!serverUrl) return false;
    try {
        return new URL(resolvedUrl).origin === new URL(serverUrl).origin;
    } catch {
        return false;
    }
}

/** Add the x-api-key header only when the request targets the relay. Mutates in place. */
function injectApiKey(headers: Headers, resolvedUrl: string): void {
    const { apiKey } = getMobileRuntimeConfig();
    if (apiKey && targetsServer(resolvedUrl) && !headers.has("x-api-key")) {
        headers.set("x-api-key", apiKey);
    }
}

function patchInit(resolvedUrl: string, init?: RequestInit): RequestInit {
    const headers = new Headers(init?.headers);
    injectApiKey(headers, resolvedUrl);
    return { ...init, headers };
}

export function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const { isMobileBundled } = getMobileRuntimeConfig();
    if (!isMobileBundled) {
        return ORIGINAL_FETCH(input, init);
    }

    if (input instanceof Request) {
        const resolvedUrl = resolveMobileUrl(input.url);
        // Spreading a Request copies nothing useful (its fields are prototype
        // getters), silently degrading the request to a bare GET. Rebuild against
        // the resolved URL to preserve method/body/headers/credentials/etc.;
        // any explicit init overrides win, matching fetch(input, init) semantics.
        const request = init
            ? new Request(new Request(resolvedUrl, input), init)
            : new Request(resolvedUrl, input);
        injectApiKey(request.headers, resolvedUrl);
        return ORIGINAL_FETCH(request);
    }

    const url = resolveMobileUrl(typeof input === "string" ? input : input.toString());
    return ORIGINAL_FETCH(url, patchInit(url, init));
}

/** Install the fetch patch. Safe to call multiple times. */
export function installMobileFetchPatch(): void {
    const { isMobileBundled } = getMobileRuntimeConfig();
    if (!isMobileBundled) return;
    if (window.fetch === patchedFetch) return;
    window.fetch = patchedFetch as typeof window.fetch;
}
