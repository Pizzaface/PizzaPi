/**
 * Track which runner services are available via service_announce events.
 * Returns a Set<string> of service IDs that updates reactively.
 *
 * ## Race condition note
 *
 * The server sends `service_announce` immediately after the viewer socket
 * connects (during the `connected` event handler). A naive useEffect-based
 * listener would miss this because React effects run AFTER the first render,
 * by which time the event has already fired.
 *
 * Solution: `attachServiceAnnounceListener()` must be called synchronously
 * when the socket is created (before any render). It stores the latest
 * announce in `socket.__serviceIds`. The hook reads this eagerly as the
 * initial state and also listens for subsequent announces.
 */
import { useState, useEffect, useRef } from "react";
import type { Socket } from "socket.io-client";
import type { RunnerInfo, ServiceAnnounceData, ServiceAnnounceDelta, ServicePanelInfo, ServiceTriggerDef, ServiceSigilDef } from "@pizzapi/protocol";
import { matchesViewerGeneration } from "@/lib/viewer-switch";

const SERVICE_IDS_KEY = "__serviceIds" as const;
const PANELS_KEY = "__panels" as const;
const TRIGGER_DEFS_KEY = "__triggerDefs" as const;
const SIGIL_DEFS_KEY = "__sigilDefs" as const;
const VIEWER_SWITCH_GENERATION_KEY = "__viewerSwitchGeneration" as const;

/** Apply a delta to the socket's cached service state in-place. */
function applyDeltaToSocket(socket: Socket, delta: ServiceAnnounceDelta): void {
    // Service IDs
    const ids: string[] = ((socket as any)[SERVICE_IDS_KEY] as string[] | undefined) ?? [];
    const removedIds = new Set(delta.removed.serviceIds);
    const filtered = ids.filter((id) => !removedIds.has(id));
    (socket as any)[SERVICE_IDS_KEY] = [...filtered, ...delta.added.serviceIds];

    // Panels (keyed by serviceId)
    const panels: ServicePanelInfo[] = ((socket as any)[PANELS_KEY] as ServicePanelInfo[] | undefined) ?? [];
    const removedPanels = new Set(delta.removed.panels);
    const updatedPanelMap = new Map(delta.updated.panels.map((p) => [p.serviceId, p]));
    const newPanels = panels
        .filter((p) => !removedPanels.has(p.serviceId))
        .map((p) => updatedPanelMap.get(p.serviceId) ?? p);
    (socket as any)[PANELS_KEY] = [...newPanels, ...delta.added.panels];

    // Trigger defs (keyed by type)
    const triggers: ServiceTriggerDef[] = ((socket as any)[TRIGGER_DEFS_KEY] as ServiceTriggerDef[] | undefined) ?? [];
    const removedTriggers = new Set(delta.removed.triggerDefs);
    const updatedTriggerMap = new Map(delta.updated.triggerDefs.map((t) => [t.type, t]));
    const newTriggers = triggers
        .filter((t) => !removedTriggers.has(t.type))
        .map((t) => updatedTriggerMap.get(t.type) ?? t);
    (socket as any)[TRIGGER_DEFS_KEY] = [...newTriggers, ...delta.added.triggerDefs];

    // Sigil defs (keyed by type)
    const sigils: ServiceSigilDef[] = ((socket as any)[SIGIL_DEFS_KEY] as ServiceSigilDef[] | undefined) ?? [];
    const removedSigils = new Set(delta.removed.sigilDefs);
    const updatedSigilMap = new Map(delta.updated.sigilDefs.map((s) => [s.type, s]));
    const newSigils = sigils
        .filter((s) => !removedSigils.has(s.type))
        .map((s) => updatedSigilMap.get(s.type) ?? s);
    (socket as any)[SIGIL_DEFS_KEY] = [...newSigils, ...delta.added.sigilDefs];
}

/**
 * Call this synchronously right after creating the viewer socket.
 * Attaches a persistent listener that captures service_announce events
 * so they're available before any React hooks mount.
 */
export function attachServiceAnnounceListener(socket: Socket): void {
    socket.on("service_announce", (data: ServiceAnnounceData & { generation?: number }) => {
        const currentGeneration = (socket as any)[VIEWER_SWITCH_GENERATION_KEY] as number | undefined;
        if (!matchesViewerGeneration(currentGeneration, data.generation)) {
            return;
        }
        (socket as any)[SERVICE_IDS_KEY] = data.serviceIds;
        (socket as any)[PANELS_KEY] = data.panels;
        (socket as any)[TRIGGER_DEFS_KEY] = data.triggerDefs;
        (socket as any)[SIGIL_DEFS_KEY] = data.sigilDefs;
    });
    socket.on("service_announce_delta", (data: ServiceAnnounceDelta & { generation?: number }) => {
        const currentGeneration = (socket as any)[VIEWER_SWITCH_GENERATION_KEY] as number | undefined;
        if (!matchesViewerGeneration(currentGeneration, data.generation)) {
            return;
        }
        applyDeltaToSocket(socket, data);
    });
    socket.on("disconnect", () => {
        (socket as any)[SERVICE_IDS_KEY] = undefined;
        (socket as any)[PANELS_KEY] = undefined;
        (socket as any)[TRIGGER_DEFS_KEY] = undefined;
        (socket as any)[SIGIL_DEFS_KEY] = undefined;
    });
}

/**
 * Copy service IDs and panel info from a previous viewer socket onto a new one.
 * Used during same-runner session switches so useRunnerServices doesn't flash
 * to empty while waiting for the new socket's service_announce event.
 */
export function seedServiceCache(newSocket: Socket, prevSocket: Socket | null): void {
    if (!prevSocket) return;
    const ids = (prevSocket as any)[SERVICE_IDS_KEY] as string[] | undefined;
    const panels = (prevSocket as any)[PANELS_KEY] as ServicePanelInfo[] | undefined;
    const triggerDefs = (prevSocket as any)[TRIGGER_DEFS_KEY] as ServiceTriggerDef[] | undefined;
    const sigilDefs = (prevSocket as any)[SIGIL_DEFS_KEY] as ServiceSigilDef[] | undefined;
    if (ids) (newSocket as any)[SERVICE_IDS_KEY] = ids;
    if (panels) (newSocket as any)[PANELS_KEY] = panels;
    if (triggerDefs) (newSocket as any)[TRIGGER_DEFS_KEY] = triggerDefs;
    if (sigilDefs) (newSocket as any)[SIGIL_DEFS_KEY] = sigilDefs;
}

export function setViewerSwitchGeneration(socket: Socket, generation: number): void {
    (socket as any)[VIEWER_SWITCH_GENERATION_KEY] = generation;
}

/** Read any already-captured service IDs from the socket. */
function getEagerServiceIds(socket: Socket | null): Set<string> {
    const ids = socket ? (socket as any)[SERVICE_IDS_KEY] as string[] | undefined : undefined;
    return ids ? new Set(ids) : new Set();
}

/** Read any already-captured panels from the socket. */
function getEagerPanels(socket: Socket | null): ServicePanelInfo[] {
    return (socket ? (socket as any)[PANELS_KEY] as ServicePanelInfo[] | undefined : undefined) ?? [];
}

/** Read any already-captured trigger defs from the socket. */
function getEagerTriggerDefs(socket: Socket | null): ServiceTriggerDef[] {
    return (socket ? (socket as any)[TRIGGER_DEFS_KEY] as ServiceTriggerDef[] | undefined : undefined) ?? [];
}

/** Read any already-captured sigil defs from the socket. */
function getEagerSigilDefs(socket: Socket | null): ServiceSigilDef[] {
    return (socket ? (socket as any)[SIGIL_DEFS_KEY] as ServiceSigilDef[] | undefined : undefined) ?? [];
}

export interface RunnerServicesState {
    services: Set<string>;
    panels: ServicePanelInfo[];
    triggerDefs: ServiceTriggerDef[];
    sigilDefs: ServiceSigilDef[];
}

function hasRunnerServiceMetadata(runnerInfo: RunnerInfo | null | undefined): boolean {
    return !!runnerInfo && (
        (runnerInfo.serviceIds?.length ?? 0) > 0 ||
        (runnerInfo.panels?.length ?? 0) > 0 ||
        (runnerInfo.triggerDefs?.length ?? 0) > 0 ||
        (runnerInfo.sigilDefs?.length ?? 0) > 0
    );
}

function runnerInfoToServices(runnerInfo: RunnerInfo | null | undefined): RunnerServicesState {
    return {
        services: new Set(runnerInfo?.serviceIds ?? []),
        panels: runnerInfo?.panels ?? [],
        triggerDefs: runnerInfo?.triggerDefs ?? [],
        sigilDefs: runnerInfo?.sigilDefs ?? [],
    };
}

export function useRunnerServices(socket: Socket | null, runnerInfo: RunnerInfo | null = null): RunnerServicesState {
    const initialFromRunner = hasRunnerServiceMetadata(runnerInfo) ? runnerInfoToServices(runnerInfo) : null;
    const [services, setServices] = useState<Set<string>>(() => initialFromRunner?.services ?? getEagerServiceIds(socket));
    const [panels, setPanels] = useState<ServicePanelInfo[]>(() => initialFromRunner?.panels ?? getEagerPanels(socket));
    const [triggerDefs, setTriggerDefs] = useState<ServiceTriggerDef[]>(() => initialFromRunner?.triggerDefs ?? getEagerTriggerDefs(socket));
    const [sigilDefs, setSigilDefs] = useState<ServiceSigilDef[]>(() => initialFromRunner?.sigilDefs ?? getEagerSigilDefs(socket));
    const prevSocketRef = useRef(socket);

    if (socket !== prevSocketRef.current) {
        prevSocketRef.current = socket;
    }

    useEffect(() => {
        if (!socket) {
            setServices(new Set());
            setPanels([]);
            setTriggerDefs([]);
            setSigilDefs([]);
            return;
        }

        // Prefer runner-feed metadata when available. The feed now carries the
        // runner's service metadata, so the viewer can join by runnerId instead
        // of depending on per-session service_announce copies.
        if (hasRunnerServiceMetadata(runnerInfo)) {
            const next = runnerInfoToServices(runnerInfo);
            setServices(next.services);
            setPanels(next.panels);
            setTriggerDefs(next.triggerDefs);
            setSigilDefs(next.sigilDefs);
        } else if (runnerInfo === null) {
            // True non-runner/local session: clear stale runner service state.
            setServices(new Set());
            setPanels([]);
            setTriggerDefs([]);
            setSigilDefs([]);
        } else {
            // Runner is known but feed metadata is not hydrated yet.
            // Read any eagerly captured announce data (including values seeded
            // via seedServiceCache for same-runner switches) and apply it
            // unconditionally. When the cache is empty, this clears stale
            // service state from the previous session instead of leaving old
            // panels/triggers visible.
            setServices(getEagerServiceIds(socket));
            setPanels(getEagerPanels(socket));
            setTriggerDefs(getEagerTriggerDefs(socket));
            setSigilDefs(getEagerSigilDefs(socket));
        }

        const handleAnnounce = (data: ServiceAnnounceData & { generation?: number }) => {
            const currentGeneration = (socket as any)[VIEWER_SWITCH_GENERATION_KEY] as number | undefined;
            if (!matchesViewerGeneration(currentGeneration, data.generation)) {
                return;
            }
            const useRunnerFeed = data._runnerRef === true && runnerInfo?.runnerId === data.runnerId && hasRunnerServiceMetadata(runnerInfo);
            const next = useRunnerFeed ? runnerInfoToServices(runnerInfo) : {
                services: new Set(data.serviceIds),
                panels: data.panels ?? [],
                triggerDefs: data.triggerDefs ?? [],
                sigilDefs: data.sigilDefs ?? [],
            };
            setServices(next.services);
            setPanels(next.panels);
            setTriggerDefs(next.triggerDefs);
            setSigilDefs(next.sigilDefs);
        };

        const handleDelta = (data: ServiceAnnounceDelta & { generation?: number }) => {
            const currentGeneration = (socket as any)[VIEWER_SWITCH_GENERATION_KEY] as number | undefined;
            if (!matchesViewerGeneration(currentGeneration, data.generation)) {
                return;
            }
            // Apply the delta to socket cache (already done by the persistent listener)
            // and then read back the updated values for React state.
            const newIds = (socket as any)[SERVICE_IDS_KEY] as string[] | undefined;
            const newPanels = (socket as any)[PANELS_KEY] as ServicePanelInfo[] | undefined;
            const newTriggerDefs = (socket as any)[TRIGGER_DEFS_KEY] as ServiceTriggerDef[] | undefined;
            const newSigilDefs = (socket as any)[SIGIL_DEFS_KEY] as ServiceSigilDef[] | undefined;
            const useRunnerFeed = data._runnerRef === true && runnerInfo?.runnerId === data.runnerId && hasRunnerServiceMetadata(runnerInfo);
            if (useRunnerFeed) {
                const next = runnerInfoToServices(runnerInfo);
                setServices(next.services);
                setPanels(next.panels);
                setTriggerDefs(next.triggerDefs);
                setSigilDefs(next.sigilDefs);
                return;
            }
            setServices(new Set(newIds ?? []));
            setPanels(newPanels ?? []);
            setTriggerDefs(newTriggerDefs ?? []);
            setSigilDefs(newSigilDefs ?? []);
        };

        // NOTE: No handleDisconnect listener — we intentionally preserve
        // the previous services/panels state when the socket disconnects
        // during a session switch. The old socket fires `disconnect`
        // synchronously before the new socket is set, which would flash
        // panels to empty and cause them to unmount/remount. Instead, we
        // only clear when the effect re-runs with socket === null (no
        // session selected), and the new socket's service_announce will
        // replace the values once it arrives.

        socket.on("service_announce", handleAnnounce);
        socket.on("service_announce_delta", handleDelta);

        return () => {
            socket.off("service_announce", handleAnnounce);
            socket.off("service_announce_delta", handleDelta);
        };
    }, [socket, runnerInfo]);

    return { services, panels, triggerDefs, sigilDefs };
}
