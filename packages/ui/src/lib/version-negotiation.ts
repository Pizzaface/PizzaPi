import { compareSemver } from "@pizzapi/protocol";

export interface VersionNegotiationResult {
    serverVersion: string | null;
    serverSocketProtocol: number | null;
    updateAvailable: boolean;
    protocolCompatible: boolean;
    message: string | null;
}

export function evaluateVersionNegotiation(
    payload: unknown,
    opts: {
        uiVersion: string;
        clientSocketProtocol: number;
    },
): VersionNegotiationResult {
    const rawVersion =
        payload && typeof payload === "object" && "version" in payload
            ? (payload as { version?: unknown }).version
            : undefined;

    const serverVersion =
        rawVersion && typeof rawVersion === "object" && typeof (rawVersion as { server?: unknown }).server === "string"
            ? ((rawVersion as { server: string }).server || null)
            : null;

    const serverSocketProtocol =
        rawVersion && typeof rawVersion === "object" && Number.isInteger((rawVersion as { socketProtocol?: unknown }).socketProtocol)
            ? Number((rawVersion as { socketProtocol: number }).socketProtocol)
            : null;

    const updateAvailable =
        typeof serverVersion === "string" &&
        !!serverVersion &&
        compareSemver(serverVersion, opts.uiVersion) === 1;

    const protocolCompatible =
        serverSocketProtocol === null ? true : serverSocketProtocol === opts.clientSocketProtocol;

    let message: string | null = null;

    if (!protocolCompatible) {
        message =
            `Server protocol mismatch (server ${serverSocketProtocol}, UI ${opts.clientSocketProtocol}). ` +
            "Please refresh the page and update PizzaPi to restore full compatibility.";
    } else if (updateAvailable && serverVersion) {
        message = `Server v${serverVersion.replace(/^v/i, "")} is newer than this UI (v${opts.uiVersion.replace(/^v/i, "")}). Refresh to update.`;
    }

    return {
        serverVersion,
        serverSocketProtocol,
        updateAvailable,
        protocolCompatible,
        message,
    };
}
