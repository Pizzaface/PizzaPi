/**
 * Pure utility for comparing ServiceAnnounceData payloads.
 * Kept in its own module so tests can import just this helper
 * without pulling in the full runner namespace and its transitive deps.
 */
import type { ServiceAnnounceData } from "@pizzapi/protocol";

/**
 * Returns true when two ServiceAnnounceData payloads are semantically
 * identical (same serviceIds in the same order, same panel metadata).
 * Used by the service_announce handler to skip no-op fanouts.
 */
export function isSameServiceAnnounce(
    a: ServiceAnnounceData | null | undefined,
    b: ServiceAnnounceData | null | undefined,
): boolean {
    if (!a || !b) return false;
    if (a.serviceIds.length !== b.serviceIds.length) return false;
    for (let i = 0; i < a.serviceIds.length; i++) {
        if (a.serviceIds[i] !== b.serviceIds[i]) return false;
    }

    const aPanels = a.panels ?? [];
    const bPanels = b.panels ?? [];
    if (aPanels.length !== bPanels.length) return false;
    for (let i = 0; i < aPanels.length; i++) {
        const left = aPanels[i];
        const right = bPanels[i];
        if (
            left.serviceId !== right.serviceId ||
            left.port !== right.port ||
            left.label !== right.label ||
            left.icon !== right.icon
        ) {
            return false;
        }
    }

    return true;
}
