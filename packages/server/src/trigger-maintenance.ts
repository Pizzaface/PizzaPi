/**
 * Trigger-system maintenance loops (ADR-0002).
 *
 * Extracted from index.ts so both the production server and the test sandbox
 * harness (tests/harness/server.ts) run the same sweeps — the sandbox never
 * executes index.ts, which left contract expiry / inflight backstop / wake
 * retry / dead-runner cleanup silently untestable end-to-end.
 */

import { sweepExpiredContracts, sweepStaleInflight, sweepUnresolvedSpawnIntents } from "./events/engine.js";
import { createEngineDeps, sweepFailedWakes } from "./events/transport.js";
import { pruneEvents } from "./events/store.js";
import { sweepDeadRunners } from "./events/runner-liveness.js";
import { runWithAuthContext, type AuthContext } from "./auth.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("trigger-sweeps");

/**
 * Start the trigger maintenance intervals. Intervals are configurable for
 * tests (the sandbox shortens them). Returns stop functions for shutdown.
 */
export function startTriggerMaintenance(
    authContext: AuthContext,
    opts?: { contractSweepMs?: number; retentionSweepMs?: number },
): Array<() => void> {
    const contractSweepMs = opts?.contractSweepMs ?? 30_000;
    const retentionSweepMs = opts?.retentionSweepMs ?? 60 * 60 * 1000;

    const contractTimer = setInterval(() => {
        void runWithAuthContext(authContext, async () => {
            try {
                await sweepExpiredContracts(createEngineDeps());
            } catch (err) {
                log.error("Trigger contract sweep failed:", err);
            }
            try {
                // Delivery guarantees backstop: rows stuck inflight (emitter died
                // between claim and ack settle) return to pending for re-delivery.
                await sweepStaleInflight();
            } catch (err) {
                log.error("Stale inflight delivery sweep failed:", err);
            }
            try {
                // Failed-wake retry: pending wake-marked deliveries whose worker
                // never came up get one re-attempt per 5 minutes (multi-node safe —
                // the wake lock dedups the respawn).
                const retried = await sweepFailedWakes();
                if (retried > 0) log.info(`Wake retry sweep re-attempted ${retried} wake(s).`);
            } catch (err) {
                log.error("Failed-wake retry sweep failed:", err);
            }
            try {
                // Spawn intents whose emit reached no runner (or whose spawning
                // process died between claim and resolution) never resolve —
                // drop them so they stop haunting the dedup-resume path.
                await sweepUnresolvedSpawnIntents();
            } catch (err) {
                log.error("Unresolved spawn intent sweep failed:", err);
            }
        });
    }, contractSweepMs);
    contractTimer.unref();

    const retentionTimer = setInterval(() => {
        void runWithAuthContext(authContext, async () => {
            try {
                const pruned = await pruneEvents();
                if (pruned > 0) log.info(`Pruned ${pruned} expired trigger event(s).`);
            } catch (err) {
                log.error("Failed to prune trigger events:", err);
            }
            try {
                // Runners unseen for 7 days with no live socket anywhere: expire
                // their pending wake deliveries and flag them for route listings.
                await sweepDeadRunners();
            } catch (err) {
                log.error("Dead-runner sweep failed:", err);
            }
        });
    }, retentionSweepMs);
    retentionTimer.unref();

    return [
        () => clearInterval(contractTimer),
        () => clearInterval(retentionTimer),
    ];
}
