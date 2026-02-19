import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
    baseURL: `${window.location.origin}/api/auth`,
    plugins: [apiKeyClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
