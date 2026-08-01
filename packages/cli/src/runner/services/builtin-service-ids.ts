/**
 * Reserved built-in runner service IDs (docs/specs/pi-pizzapi-overlay.md §8).
 *
 * Single source of truth for "which service ids are built-in and therefore
 * always win a collision, even when disabled." Package/legacy discovery
 * loaders and daemon reconfiguration all import this set instead of
 * maintaining their own literal — see builtin-service-ids.test.ts, which
 * instantiates the real built-in service classes daemon.ts registers and
 * pins that their `.id`s are exactly this set.
 *
 * ponytail: builtin-service-ids.test.ts's characterization instantiates a
 * second, manually-mirrored list of the seven service classes rather than
 * deriving them from daemon.ts's actual `registry.register(new XyzService(...))`
 * call sites — if daemon.ts ever registers an eighth built-in, this test
 * won't catch the drift. Fixing that for real means centralizing built-in
 * construction into one shared factory daemon.ts and the test both call
 * (the constructors close over per-daemon runtime state — session pid
 * lookup, tunnel wiring — so this is a real refactor, not a one-liner).
 * Upgrade when a built-in is added/removed and the mirrored list actually
 * drifts, or as part of a dedicated daemon.ts service-registration cleanup.
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

/**
 * Built-in ids that must NEVER be torn down at runtime via
 * `reconfigure_services` (distinct from BUILTIN_SERVICE_IDS, which is
 * collision-reservation only — "a package/legacy service can't claim this
 * id", not "this id can't be disabled"). "memory" and "process" were
 * runtime-disableable before package-origin discovery unified the daemon's
 * inline reconfigure BUILTIN_IDS set (which historically omitted them) into
 * the 7-id BUILTIN_SERVICE_IDS — that unification accidentally made them
 * permanently non-disableable at runtime too. This narrower set preserves
 * the original 5 (terminal/file-explorer/git/time/tunnel) as the ones
 * `reconfigure_services` refuses to dispose; memory/process stay
 * disable-at-runtime like before.
 */
export const NON_DISABLEABLE_SERVICE_IDS: ReadonlySet<string> = new Set([
    "terminal",
    "file-explorer",
    "git",
    "time",
    "tunnel",
]);
