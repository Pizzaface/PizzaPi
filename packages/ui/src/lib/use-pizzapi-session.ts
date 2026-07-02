/**
 * Session hook that supports both normal cookie-based auth and the bundled
 * Capacitor app mode, where the mobile bootstrap injects an API key instead of
 * a browser session cookie.
 */
import * as React from "react";
import { useSession, type BetterAuthSession } from "./auth-client.js";
import { getMobileRuntimeConfig } from "./mobile-runtime.js";
import { logFrontendEvent } from "./frontend-log.js";

interface ApiKeySession {
    user: {
        id: string;
        name: string;
        email: string;
    };
    session: {
        id: string;
        userId: string;
    };
}

function createSyntheticSession(userId: string, userName: string): BetterAuthSession {
    return {
        user: {
            id: userId,
            name: userName,
            email: "",
            emailVerified: true,
            image: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        },
        session: {
            id: `mobile-${userId}`,
            token: "",
            userId,
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ipAddress: null,
            userAgent: null,
        },
    } as unknown as BetterAuthSession;
}

/** Shape returned by useSession(), reused so App.tsx doesn't need to change. */
export interface PizzaPiSession {
    data: BetterAuthSession | null;
    isPending: boolean;
}

export function usePizzaPiSession(): PizzaPiSession {
    const { data: cookieSession, isPending: cookiePending } = useSession();
    const { isMobileBundled, apiKey } = getMobileRuntimeConfig();

    const [apiKeySession, setApiKeySession] = React.useState<ApiKeySession | null>(null);
    const [apiKeyPending, setApiKeyPending] = React.useState(isMobileBundled && !!apiKey);

    React.useEffect(() => {
        if (!isMobileBundled || !apiKey) {
            setApiKeyPending(false);
            return;
        }
        if (cookieSession?.user?.id) {
            setApiKeyPending(false);
            return;
        }

        let cancelled = false;
        setApiKeyPending(true);
        logFrontendEvent("auth", "info", "Resolving mobile session via /api/me");
        fetch("/api/me")
            .then(async (res) => {
                if (cancelled) return;
                if (!res.ok) throw new Error(`/api/me returned HTTP ${res.status}`);
                const data = (await res.json()) as { userId: string; userName: string };
                logFrontendEvent("auth", "info", "Mobile session resolved", `userId=${data.userId}`);
                setApiKeySession({
                    user: { id: data.userId, name: data.userName, email: "" },
                    session: { id: `mobile-${data.userId}`, userId: data.userId },
                });
            })
            .catch((err: unknown) => {
                // Leave pending=false; App.tsx will show the sign-in gate.
                logFrontendEvent("auth", "error", "Failed to resolve mobile session", err instanceof Error ? err.message : String(err));
            })
            .finally(() => {
                if (!cancelled) setApiKeyPending(false);
            });

        return () => {
            cancelled = true;
        };
    }, [isMobileBundled, apiKey, cookieSession?.user?.id]);

    if (cookieSession?.user?.id) {
        return { data: cookieSession, isPending: cookiePending };
    }

    if (apiKeySession) {
        return { data: createSyntheticSession(apiKeySession.user.id, apiKeySession.user.name), isPending: false };
    }

    return { data: null, isPending: cookiePending || apiKeyPending };
}
