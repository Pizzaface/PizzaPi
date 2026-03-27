import { SOCKET_PROTOCOL_VERSION } from "@pizzapi/protocol";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let cachedServerVersion: string | null | undefined;
let cachedBuildTimestamp: string | null | undefined;
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

/**
 * Read the UI build timestamp from the dist/build-info.json file emitted by
 * Vite at UI build time.  The server reads this from the mounted UI dist
 * directory so that the same timestamp is served regardless of whether the UI
 * was built locally or pulled from a GHCR image.
 *
 * The UI dist directory is located via the PIZZAPI_UI_DIR env var (set in the
 * Dockerfile) with a relative fallback for local development.
 *
 * Cached after first successful read; returns null when the file is absent.
 */
export function getUiBuildTimestamp(): string | null {
    if (cachedBuildTimestamp !== undefined) return cachedBuildTimestamp;

    const uiDir =
        process.env.PIZZAPI_UI_DIR ??
        join(import.meta.dirname ?? __dirname, "../../packages/ui/dist");

    try {
        const raw = readFileSync(join(uiDir, "build-info.json"), "utf-8");
        const info = JSON.parse(raw) as { buildTimestamp?: unknown };
        cachedBuildTimestamp =
            typeof info.buildTimestamp === "string" && info.buildTimestamp.trim()
                ? info.buildTimestamp.trim()
                : null;
    } catch {
        cachedBuildTimestamp = null;
    }

    return cachedBuildTimestamp;
}

export async function getServerRuntimeInfo(): Promise<{
    serverVersion: string | null;
    socketProtocolVersion: number;
    buildTimestamp: string | null;
}> {
    return {
        serverVersion: await getServerVersion(),
        socketProtocolVersion: SOCKET_PROTOCOL_VERSION,
        buildTimestamp: getUiBuildTimestamp(),
    };
}
