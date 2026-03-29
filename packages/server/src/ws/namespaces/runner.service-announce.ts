/**
 * Pure utility for comparing ServiceAnnounceData payloads.
 * Kept in its own module so tests can import just this helper
 * without pulling in the full runner namespace and its transitive deps.
 */
import type { ServiceAnnounceData } from "@pizzapi/protocol";

/**
 * Returns true when two ServiceAnnounceData payloads are semantically
 * identical (same serviceIds in the same order, same panel metadata,
 * same trigger defs in the same order).
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

    const aDefs = a.triggerDefs ?? [];
    const bDefs = b.triggerDefs ?? [];
    if (aDefs.length !== bDefs.length) return false;
    for (let i = 0; i < aDefs.length; i++) {
        const left = aDefs[i];
        const right = bDefs[i];
        if (
            left.type !== right.type ||
            left.label !== right.label ||
            left.description !== right.description
        ) {
            return false;
        }
        // Compare schema via stable JSON stringify so schema-only changes
        // are not silently dropped (e.g. adding a property to the schema).
        const leftSchema = left.schema !== undefined ? JSON.stringify(left.schema) : undefined;
        const rightSchema = right.schema !== undefined ? JSON.stringify(right.schema) : undefined;
        if (leftSchema !== rightSchema) {
            return false;
        }
        // Compare params so changes to configurable parameters are detected.
        const leftParams = left.params !== undefined ? JSON.stringify(left.params) : undefined;
        const rightParams = right.params !== undefined ? JSON.stringify(right.params) : undefined;
        if (leftParams !== rightParams) {
            return false;
        }
    }

    return true;
}
