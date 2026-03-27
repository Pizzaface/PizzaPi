export type UserErrorContext =
    | "session_spawn"
    | "runner_restart"
    | "runner_stop"
    | "viewer_connection"
    | "generic";

export interface UserErrorInput {
    error?: unknown;
    statusCode?: number;
    context?: UserErrorContext;
    fallbackMessage?: string;
}

export interface UserErrorResult {
    userMessage: string;
    technicalMessage: string;
}

function coerceErrorMessage(error: unknown): string {
    if (typeof error === "string") return error.trim();
    if (error instanceof Error) return error.message.trim();
    if (error && typeof error === "object") {
        const maybeMessage = (error as { message?: unknown }).message;
        if (typeof maybeMessage === "string") return maybeMessage.trim();
    }
    return "";
}

function extractStatusCode(message: string): number | null {
    const match = message.match(/\bHTTP\s*([1-5]\d{2})\b/i);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Extracts an HTTP status code from non-message fields of a Socket.IO error.
 *
 * When Socket.IO's XHR transport gets a 401/403 response, it reports:
 *   err.message      = "xhr poll error"   (transport-level description)
 *   err.description  = { status: 401 }    (the actual HTTP response object)
 *   err.context      = { status: 401 }    (alternative field in some versions)
 *
 * Without this check those auth failures are misclassified as network errors
 * because "xhr poll error" is matched by the network-error branch first.
 */
function extractSocketIOStatusCode(error: unknown): number | null {
    if (!error || typeof error !== "object") return null;

    // Socket.IO v4: err.description may be an XHR object or a plain object with .status
    const errObj = error as Record<string, unknown>;

    for (const field of ["description", "context"]) {
        const candidate = errObj[field];
        if (!candidate || typeof candidate !== "object") continue;
        const status = (candidate as Record<string, unknown>).status;
        if (typeof status === "number" && status >= 100 && status <= 599) {
            return status;
        }
    }

    return null;
}

function defaultFallbackForContext(context: UserErrorContext): string {
    switch (context) {
        case "session_spawn":
            return "Couldn't start a new session. Please try again.";
        case "runner_restart":
            return "Couldn't restart the runner. Please try again.";
        case "runner_stop":
            return "Couldn't stop the runner. Please try again.";
        case "viewer_connection":
            return "Couldn't connect to the session. Check your connection and try again.";
        default:
            return "Something went wrong. Please try again.";
    }
}

export function mapUserError(input: UserErrorInput): UserErrorResult {
    const context = input.context ?? "generic";
    const technicalFromError = coerceErrorMessage(input.error);
    const statusCode =
        input.statusCode ??
        extractStatusCode(technicalFromError) ??
        extractSocketIOStatusCode(input.error) ??
        undefined;
    const technicalMessage = technicalFromError || (statusCode ? `HTTP ${statusCode}` : "Unknown error");

    const normalized = technicalMessage.toLowerCase();

    const fallback = input.fallbackMessage ?? defaultFallbackForContext(context);

    if (normalized.includes("runner not found")) {
        return {
            userMessage: "That runner is no longer available. Refresh the runner list and try again.",
            technicalMessage,
        };
    }

    if (
        normalized.includes("failed to send spawn request to runner") ||
        normalized.includes("runner is not connected to this server") ||
        (context === "session_spawn" && statusCode !== undefined && [502, 503, 504].includes(statusCode))
    ) {
        return {
            userMessage: "Couldn't reach the selected runner. Make sure `pizzapi runner` is online, then try again.",
            technicalMessage,
        };
    }

    if (normalized.includes("missing sessionid")) {
        return {
            userMessage: "The runner started but didn't return full session details. Try again, or restart the runner if this keeps happening.",
            technicalMessage,
        };
    }

    if (normalized.includes("forbidden") || normalized.includes("unauthorized") || statusCode === 401 || statusCode === 403) {
        return {
            userMessage: "You don't have access to do that right now. Sign in again and retry.",
            technicalMessage,
        };
    }

    if (
        context === "viewer_connection" && (
            normalized.includes("connect error") ||
            normalized.includes("connect_error") ||
            normalized.includes("failed to fetch") ||
            normalized.includes("network error") ||
            normalized.includes("websocket") ||
            normalized.includes("xhr poll error") ||
            normalized.includes("transport error") ||
            statusCode === 502 ||
            statusCode === 503 ||
            statusCode === 504
        )
    ) {
        return {
            userMessage: "Lost connection to PizzaPi. Check your network, then reconnect.",
            technicalMessage,
        };
    }

    if (context === "session_spawn" && statusCode === 400) {
        return {
            userMessage: "Couldn't start that session with the selected options. Check the folder path and try again.",
            technicalMessage,
        };
    }

    if (statusCode === 404) {
        return {
            userMessage: "The requested item could not be found. Refresh and try again.",
            technicalMessage,
        };
    }

    if (statusCode !== undefined && statusCode >= 500) {
        return {
            userMessage: "PizzaPi hit a temporary server problem. Please retry in a moment.",
            technicalMessage,
        };
    }

    if (normalized.includes("session not found")) {
        return {
            userMessage: "This session no longer exists. It may have ended or been removed.",
            technicalMessage,
        };
    }

    if (normalized.includes("snapshot not available") || normalized.includes("load session snapshot")) {
        return {
            userMessage: "Session history couldn't be loaded. Try refreshing.",
            technicalMessage,
        };
    }

    return {
        userMessage: fallback,
        technicalMessage,
    };
}
