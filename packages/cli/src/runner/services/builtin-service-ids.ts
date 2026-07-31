/**
 * Reserved built-in runner service IDs (docs/specs/pi-pizzapi-overlay.md §8).
 *
 * Single source of truth for "which service ids are built-in and therefore
 * always win a collision, even when disabled." Package/legacy discovery
 * loaders and daemon reconfiguration all import this set instead of
 * maintaining their own literal — see builtin-service-ids.test.ts, which
 * instantiates the real built-in service classes daemon.ts registers and
 * pins that their `.id`s are exactly this set.
 */
export const BUILTIN_SERVICE_IDS: ReadonlySet<string> = new Set([
    "terminal",
    "file-explorer",
    "git",
    "memory",
    "process",
    "time",
    "tunnel",
]);
