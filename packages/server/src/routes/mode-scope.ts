/**
 * Server-side enforcement for mode-scoped trigger defs (services[].modes).
 *
 * The web UI already hides mode-scoped surfaces, but agent tools
 * (list_available_triggers / subscribe_trigger) and runner trigger listeners
 * reach the relay routes directly — this is the chokepoint that makes the
 * scoping real rather than cosmetic.
 */
import { findSessionMode, surfaceVisibleInMode } from "@pizzapi/protocol";
import type { ServiceModeDef, ServiceTriggerDef } from "@pizzapi/protocol";

/**
 * Whether a trigger def is allowed for a cwd on a runner. Unscoped defs are
 * always allowed; scoped defs require the cwd to resolve (deepest-workspace
 * wins, same as the UI) to one of the def's modes. A missing/empty cwd can
 * never match a mode, so it only sees unscoped triggers.
 */
export function triggerAllowedForCwd(
    def: ServiceTriggerDef,
    sessionModes: ServiceModeDef[] | undefined,
    cwd: string | null | undefined,
    runnerId: string,
): boolean {
    if (!def.modes || def.modes.length === 0) return true;
    const mode = findSessionMode({ cwd: cwd ?? null, runnerId }, sessionModes ?? [], runnerId);
    return surfaceVisibleInMode(def.modes, mode);
}
