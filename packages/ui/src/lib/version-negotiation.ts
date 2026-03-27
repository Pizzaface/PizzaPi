import { compareSemver } from "@pizzapi/protocol";

export interface VersionNegotiationResult {
    serverVersion: string | null;
    serverSocketProtocol: number | null;
    serverBuildTimestamp: string | null;
    updateAvailable: boolean;
    protocolCompatible: boolean;
    message: string | null;
}

export function evaluateVersionNegotiation(
    payload: unknown,
    opts: {
        uiVersion: string;
        clientSocketProtocol: number;
        /** Build timestamp baked into this UI bundle at compile time. */
        uiBuildTimestamp?: string | null;
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

    const serverBuildTimestamp =
        rawVersion &&
        typeof rawVersion === "object" &&
        typeof (rawVersion as { buildTimestamp?: unknown }).buildTimestamp === "string"
            ? ((rawVersion as { buildTimestamp: string }).buildTimestamp || null)
            : null;

    const semverNewer =
        typeof serverVersion === "string" &&
        !!serverVersion &&
        compareSemver(serverVersion, opts.uiVersion) === 1;

    // When semver is the same, check build timestamps as a secondary signal.
    // If the server's build timestamp is strictly newer than the one baked into
    // this UI bundle, a new image was deployed after the user loaded the page.
    const buildTimestampMismatch =
        !semverNewer &&
        typeof serverBuildTimestamp === "string" &&
        serverBuildTimestamp !== null &&
        typeof opts.uiBuildTimestamp === "string" &&
        opts.uiBuildTimestamp !== null &&
        serverBuildTimestamp > opts.uiBuildTimestamp;

    const updateAvailable = semverNewer || buildTimestampMismatch;

    const protocolCompatible =
        serverSocketProtocol === null ? true : serverSocketProtocol === opts.clientSocketProtocol;

    let message: string | null = null;

    if (!protocolCompatible) {
        message =
            `Server protocol mismatch (server ${serverSocketProtocol}, UI ${opts.clientSocketProtocol}). ` +
            "Please refresh the page and update PizzaPi to restore full compatibility.";
    } else if (semverNewer && serverVersion) {
        message = `Server v${serverVersion.replace(/^v/i, "")} is newer than this UI (v${opts.uiVersion.replace(/^v/i, "")}). Refresh to update.`;
    } else if (buildTimestampMismatch) {
        message = "A newer version of PizzaPi has been deployed. Refresh to update.";
    }

    return {
        serverVersion,
        serverSocketProtocol,
        serverBuildTimestamp,
        updateAvailable,
        protocolCompatible,
        message,
    };
}
