/**
 * Relay registration gate.
 *
 * Allows other extensions (e.g. initial-prompt) to wait until the relay has
 * completed its register/registered handshake before taking actions that
 * depend on trigger delivery being available.
 */

let _relayRegisteredResolve: (() => void) | null = null;
let _relayRegisteredPromise: Promise<void> | null = null;

/** Reset the registration gate (called at the start of each connection attempt). */
export function resetRelayRegistrationGate(): void {
    _relayRegisteredPromise = new Promise<void>((resolve) => {
        _relayRegisteredResolve = resolve;
    });
}

/** Signal that the relay has registered (called from the `registered` socket handler). */
export function signalRelayRegistered(): void {
    _relayRegisteredResolve?.();
    _relayRegisteredResolve = null;
}

/**
 * Wait for the relay to complete registration, with a timeout fallback.
 * Resolves immediately if the registration gate has not been set up
 * (relay was never initialised or is disabled).
 * Falls back after `timeoutMs` so callers are never blocked forever if the
 * relay connection fails.
 *
 * Note: callers that have access to `_ctx` should check `_ctx.relay` first
 * (see `waitForRelayRegistration` in index.ts which wraps this with that check).
 */
export function waitForRelayRegistrationGated(timeoutMs: number): Promise<void> {
    if (!_relayRegisteredPromise) return Promise.resolve();
    return Promise.race([
        _relayRegisteredPromise,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
}
