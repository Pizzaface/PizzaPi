/**
 * Pure utility for comparing ServiceAnnounceData payloads.
 * Kept in its own module so tests can import just this helper
 * without pulling in the full runner namespace and its transitive deps.
 */
import type { ServiceAnnounceData, ServiceAnnounceDelta, ServicePanelInfo, ServiceTriggerDef, ServiceSigilDef } from "@pizzapi/protocol";

export function chooseServiceAnnounceSeed(
    current: ServiceAnnounceData | null | undefined,
    persisted: ServiceAnnounceData | null | undefined,
): ServiceAnnounceData | null {
    return current ?? persisted ?? null;
}

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

    // Compare sigil defs
    const aSigils = a.sigilDefs ?? [];
    const bSigils = b.sigilDefs ?? [];
    if (aSigils.length !== bSigils.length) return false;
    for (let i = 0; i < aSigils.length; i++) {
        const left = aSigils[i];
        const right = bSigils[i];
        if (
            left.type !== right.type ||
            left.label !== right.label ||
            left.description !== right.description ||
            left.icon !== right.icon ||
            left.serviceId !== right.serviceId ||
            left.resolve !== right.resolve ||
            left.resolvePort !== right.resolvePort
        ) {
            return false;
        }
        const leftAliases = left.aliases !== undefined ? JSON.stringify(left.aliases) : undefined;
        const rightAliases = right.aliases !== undefined ? JSON.stringify(right.aliases) : undefined;
        if (leftAliases !== rightAliases) return false;
        const leftSchema = left.schema !== undefined ? JSON.stringify(left.schema) : undefined;
        const rightSchema = right.schema !== undefined ? JSON.stringify(right.schema) : undefined;
        if (leftSchema !== rightSchema) return false;
    }

    return true;
}

export function shouldSkipServiceAnnounceFanout({
    previous,
    next,
    hasBroadcastLiveAnnounce,
}: {
    previous: ServiceAnnounceData | null | undefined;
    next: ServiceAnnounceData | null | undefined;
    hasBroadcastLiveAnnounce: boolean;
}): boolean {
    return hasBroadcastLiveAnnounce && isSameServiceAnnounce(previous, next);
}

// ── Delta computation ────────────────────────────────────────────────────────

function samePanelInfo(a: ServicePanelInfo, b: ServicePanelInfo): boolean {
    return a.serviceId === b.serviceId && a.port === b.port && a.label === b.label && a.icon === b.icon;
}

function sameTriggerDef(a: ServiceTriggerDef, b: ServiceTriggerDef): boolean {
    if (a.type !== b.type || a.label !== b.label || a.description !== b.description) return false;
    const aSchema = a.schema !== undefined ? JSON.stringify(a.schema) : undefined;
    const bSchema = b.schema !== undefined ? JSON.stringify(b.schema) : undefined;
    if (aSchema !== bSchema) return false;
    const aParams = a.params !== undefined ? JSON.stringify(a.params) : undefined;
    const bParams = b.params !== undefined ? JSON.stringify(b.params) : undefined;
    if (aParams !== bParams) return false;
    return true;
}

function sameSigilDef(a: ServiceSigilDef, b: ServiceSigilDef): boolean {
    if (
        a.type !== b.type ||
        a.label !== b.label ||
        a.description !== b.description ||
        a.icon !== b.icon ||
        a.serviceId !== b.serviceId ||
        a.resolve !== b.resolve ||
        a.resolvePort !== b.resolvePort
    ) return false;
    const aAliases = a.aliases !== undefined ? JSON.stringify(a.aliases) : undefined;
    const bAliases = b.aliases !== undefined ? JSON.stringify(b.aliases) : undefined;
    if (aAliases !== bAliases) return false;
    const aSchema = a.schema !== undefined ? JSON.stringify(a.schema) : undefined;
    const bSchema = b.schema !== undefined ? JSON.stringify(b.schema) : undefined;
    if (aSchema !== bSchema) return false;
    return true;
}

/**
 * Compute the delta between a previous and next ServiceAnnounceData.
 * Returns null if previous is null/undefined (caller should send a full announce).
 */
export function computeServiceAnnounceDelta(
    previous: ServiceAnnounceData | null | undefined,
    next: ServiceAnnounceData,
): ServiceAnnounceDelta | null {
    if (!previous) return null;

    const prevServiceSet = new Set(previous.serviceIds);
    const nextServiceSet = new Set(next.serviceIds);

    const addedServiceIds = next.serviceIds.filter((id) => !prevServiceSet.has(id));
    const removedServiceIds = previous.serviceIds.filter((id) => !nextServiceSet.has(id));

    // Panels — keyed by serviceId
    const prevPanels = previous.panels ?? [];
    const nextPanels = next.panels ?? [];
    const prevPanelMap = new Map(prevPanels.map((p) => [p.serviceId, p]));
    const nextPanelMap = new Map(nextPanels.map((p) => [p.serviceId, p]));

    const addedPanels: ServicePanelInfo[] = [];
    const updatedPanels: ServicePanelInfo[] = [];
    const removedPanelIds: string[] = [];

    for (const panel of nextPanels) {
        const prev = prevPanelMap.get(panel.serviceId);
        if (!prev) addedPanels.push(panel);
        else if (!samePanelInfo(prev, panel)) updatedPanels.push(panel);
    }
    for (const panel of prevPanels) {
        if (!nextPanelMap.has(panel.serviceId)) removedPanelIds.push(panel.serviceId);
    }

    // TriggerDefs — keyed by type
    const prevTriggers = previous.triggerDefs ?? [];
    const nextTriggers = next.triggerDefs ?? [];
    const prevTriggerMap = new Map(prevTriggers.map((t) => [t.type, t]));
    const nextTriggerMap = new Map(nextTriggers.map((t) => [t.type, t]));

    const addedTriggers: ServiceTriggerDef[] = [];
    const updatedTriggers: ServiceTriggerDef[] = [];
    const removedTriggerTypes: string[] = [];

    for (const trigger of nextTriggers) {
        const prev = prevTriggerMap.get(trigger.type);
        if (!prev) addedTriggers.push(trigger);
        else if (!sameTriggerDef(prev, trigger)) updatedTriggers.push(trigger);
    }
    for (const trigger of prevTriggers) {
        if (!nextTriggerMap.has(trigger.type)) removedTriggerTypes.push(trigger.type);
    }

    // SigilDefs — keyed by type
    const prevSigils = previous.sigilDefs ?? [];
    const nextSigils = next.sigilDefs ?? [];
    const prevSigilMap = new Map(prevSigils.map((s) => [s.type, s]));
    const nextSigilMap = new Map(nextSigils.map((s) => [s.type, s]));

    const addedSigils: ServiceSigilDef[] = [];
    const updatedSigils: ServiceSigilDef[] = [];
    const removedSigilTypes: string[] = [];

    for (const sigil of nextSigils) {
        const prev = prevSigilMap.get(sigil.type);
        if (!prev) addedSigils.push(sigil);
        else if (!sameSigilDef(prev, sigil)) updatedSigils.push(sigil);
    }
    for (const sigil of prevSigils) {
        if (!nextSigilMap.has(sigil.type)) removedSigilTypes.push(sigil.type);
    }

    return {
        added: {
            serviceIds: addedServiceIds,
            panels: addedPanels,
            triggerDefs: addedTriggers,
            sigilDefs: addedSigils,
        },
        removed: {
            serviceIds: removedServiceIds,
            panels: removedPanelIds,
            triggerDefs: removedTriggerTypes,
            sigilDefs: removedSigilTypes,
        },
        updated: {
            panels: updatedPanels,
            triggerDefs: updatedTriggers,
            sigilDefs: updatedSigils,
        },
    };
}

/**
 * Returns true when the delta contains no changes at all.
 */
export function isEmptyDelta(delta: ServiceAnnounceDelta): boolean {
    return (
        delta.added.serviceIds.length === 0 &&
        delta.added.panels.length === 0 &&
        delta.added.triggerDefs.length === 0 &&
        delta.added.sigilDefs.length === 0 &&
        delta.removed.serviceIds.length === 0 &&
        delta.removed.panels.length === 0 &&
        delta.removed.triggerDefs.length === 0 &&
        delta.removed.sigilDefs.length === 0 &&
        delta.updated.panels.length === 0 &&
        delta.updated.triggerDefs.length === 0 &&
        delta.updated.sigilDefs.length === 0
    );
}
