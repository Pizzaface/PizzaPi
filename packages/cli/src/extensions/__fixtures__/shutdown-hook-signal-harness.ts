/**
 * Test fixture: mirrors the worker's shutdown wiring for pre-exit hooks
 * (see runner/worker.ts `shutdown()`).
 *
 * Spawned as a subprocess by shutdown-hooks-signal.test.ts. Installs a SIGTERM
 * handler that runs runWorkerShutdownHooks — the same in-process path the
 * worker uses — with a hook that writes a marker file. The parent test SIGTERMs
 * this process and asserts the marker exists, proving hooks fire across a real
 * process/signal boundary.
 *
 * This is the boundary that matters: pi's `session_shutdown` does not fire when
 * the daemon SIGTERMs a worker, so a unit test alone would not prove the
 * capability survives.
 */
import { writeFileSync } from "node:fs";
import { registerWorkerShutdownHook, runWorkerShutdownHooks } from "../shutdown-hooks";

const markerPath = process.env.CLOSE_MARKER_PATH;
if (!markerPath) {
    console.error("CLOSE_MARKER_PATH not set");
    process.exit(1);
}

registerWorkerShutdownHook("signal-fixture", async (ctx) => {
    // Async so the test also proves the worker AWAITS the hook rather than
    // exiting while the flush is still in flight.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    writeFileSync(markerPath, JSON.stringify({ reason: ctx.reason, sessionId: ctx.sessionId }));
});

process.on("SIGTERM", () => {
    void runWorkerShutdownHooks("close")
        .catch(() => {})
        .finally(() => process.exit(0));
});

// Signal readiness and stay alive until SIGTERM.
console.log("ready");
setInterval(() => {}, 1_000);
