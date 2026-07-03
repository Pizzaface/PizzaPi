import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "better-auth/client/plugins";
import { getMobileRuntimeConfig, clearMobileApiKey } from "./mobile-runtime.js";

const { isMobileBundled, serverUrl } = getMobileRuntimeConfig();

const client = createAuthClient({
    baseURL: isMobileBundled && serverUrl ? `${serverUrl}/api/auth` : `${window.location.origin}/api/auth`,
    plugins: [apiKeyClient()],
});

const mobileSignOut = async () => {
    try {
        // The real API key lives in native secure storage — remove it there so
        // it can't be reused, not just the localStorage breadcrumbs.
        await clearMobileApiKey();
        localStorage.removeItem("pizzapi.serverUrl");
        localStorage.removeItem("pizzapi.apiKey");
    } catch { /* ignore */ }
    // ponytail: server-side key revocation is a follow-up; this only clears local secure storage.
    window.location.href = "/";
};

export const authClient = client;
export const signIn = client.signIn;
export const signUp = client.signUp;
export const signOut = isMobileBundled ? mobileSignOut : client.signOut;
export const useSession = client.useSession;

/** Typed shape of the session data returned by useSession().data */
export type BetterAuthSession = typeof client.$Infer.Session;
