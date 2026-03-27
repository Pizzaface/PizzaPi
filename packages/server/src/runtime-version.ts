import { SOCKET_PROTOCOL_VERSION } from "@pizzapi/protocol";
import { createRequire } from "node:module";

let cachedServerVersion: string | null | undefined;
const require = createRequire(import.meta.url);

/**
 * Resolve the server package version from packages/server/package.json.
 * Cached after first read.
 */
export async function getServerVersion(): Promise<string | null> {
    if (cachedServerVersion !== undefined) return cachedServerVersion;

    try {
        const pkg = require("../package.json") as { version?: unknown };
        const version = pkg?.version;
        cachedServerVersion = typeof version === "string" && version.trim() ? version.trim() : null;
    } catch {
        cachedServerVersion = null;
    }

    return cachedServerVersion;
}

export async function getServerRuntimeInfo(): Promise<{
    serverVersion: string | null;
    socketProtocolVersion: number;
}> {
    return {
        serverVersion: await getServerVersion(),
        socketProtocolVersion: SOCKET_PROTOCOL_VERSION,
    };
}
