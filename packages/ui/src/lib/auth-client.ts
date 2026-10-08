import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "better-auth/client/plugins";
import { getMobileRuntimeConfig, clearMobileApiKey, loadMobileApiKey } from "./mobile-runtime.js";
import { runMobileSignOutSteps } from "./mobile-sign-out.js";

const { isMobileBundled, serverUrl } = getMobileRuntimeConfig();

const client = createAuthClient({
    baseURL: isMobileBundled && serverUrl ? `${serverUrl}/api/auth` : `${window.location.origin}/api/auth`,
    plugins: [apiKeyClient()],
});

interface ApiKeyListItem {
    id: string;
    start: string | null;
}

const mobileSignOut = async () => {
    try {
        // Stop native push FIRST, while the API key is still valid server-side.
        // Its unregister request uses x-api-key (mobile has no cookie session).
        await runMobileSignOutSteps(
            async () => import("./ntfy-push.js").then(({ stopNtfyPush }) => stopNtfyPush()),
            async () => {
                // ponytail: best-effort server-side revocation. The mobile bootstrap
                // only hands us the raw key, while /api-key/delete requires a keyId.
                // We list the user's keys (mobile fetch patch sends x-api-key header),
                // and if exactly one key matches this device's key prefix we revoke it.
                // If there are zero or multiple prefix matches, we fall back to local
                // cleanup only. A server delete-by-key endpoint would close this gap.
                let keyToRevoke = getMobileRuntimeConfig().apiKey;
                if (!keyToRevoke) {
                    await loadMobileApiKey();
                    keyToRevoke = getMobileRuntimeConfig().apiKey;
                }
                if (keyToRevoke) {
                    const { data, error } = await authClient.$fetch<ApiKeyListItem[]>("/api-key/list");
                    if (!error && data) {
                        const matches = data.filter((k) => k.start && keyToRevoke.startsWith(k.start));
                        if (matches.length === 1) {
                            await authClient.$fetch("/api-key/delete", {
                                method: "POST",
                                body: { keyId: matches[0]!.id },
                            });
                        }
                    }
                }
            },
            clearMobileApiKey,
        );

        // The real API key lives in native secure storage — remove it there so
        // it can't be reused, not just the localStorage breadcrumbs.
        localStorage.removeItem("pizzapi.serverUrl");
        localStorage.removeItem("pizzapi.apiKey");
    } catch { /* ignore */ }
    window.location.href = "/";
};

export const authClient = client;
export const signIn = client.signIn;
export const signUp = client.signUp;
export const signOut = isMobileBundled ? mobileSignOut : client.signOut;
export const useSession = client.useSession;

/** Typed shape of the session data returned by useSession().data */
export type BetterAuthSession = typeof client.$Infer.Session;
