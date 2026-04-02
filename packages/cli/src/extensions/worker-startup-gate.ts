let armed = false;
let ready = false;
let resolveReady: (() => void) | null = null;
let readyPromise: Promise<void> = Promise.resolve();

/**
 * Arm the startup gate for runner workers.
 *
 * While armed, inbound relay-delivered turns (session triggers, remote input)
 * should wait until markWorkerStartupComplete() is called. Sessions that never
 * arm the gate (normal CLI sessions) remain ungated.
 */
export function armWorkerStartupGate(): void {
    armed = true;
    ready = false;
    readyPromise = new Promise<void>((resolve) => {
        resolveReady = resolve;
    });
}

/** Mark worker startup complete and release any queued inbound work. */
export function markWorkerStartupComplete(): void {
    if (!armed || ready) return;
    ready = true;
    resolveReady?.();
    resolveReady = null;
}

/** Wait until startup is complete if the gate is armed, otherwise resolve immediately. */
export function waitForWorkerStartupComplete(): Promise<void> {
    if (!armed || ready) return Promise.resolve();
    return readyPromise;
}

/** @internal Test-only helper. */
export function _resetWorkerStartupGateForTesting(): void {
    armed = false;
    ready = false;
    resolveReady = null;
    readyPromise = Promise.resolve();
}
