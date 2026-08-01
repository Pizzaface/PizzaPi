/**
 * Module-level SessionHost reference for the remote extension.
 *
 * `remoteExtension` is a pi `ExtensionFactory` that only receives `pi`
 * (ExtensionAPI) — it has no direct handle to the worker's session or its
 * headless in-place lifecycle actions. The worker sets the SessionHost here
 * before `bindExtensions()` runs, and the relay-context factory reads it when
 * building the `RelayContext`, so remote handlers drive session control through
 * the host instead of the patched `ExtensionAPI` surface.
 *
 * ponytail: a single module global mirrors the existing `_ctx`/socket refs in
 * remote/index.ts — no registry needed for one process-wide session host.
 */
import type { SessionHost } from "../../runner/session-host.js";

let sessionHost: SessionHost | null = null;

export function setRemoteSessionHost(host: SessionHost | null): void {
    sessionHost = host;
}

export function getRemoteSessionHost(): SessionHost | null {
    return sessionHost;
}
