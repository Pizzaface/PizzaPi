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
import type { RunnerInfo, ServiceAnnounceData, ServiceAnnounceDelta, ServiceModeDef, ServicePanelInfo, ServiceTriggerDef, ServiceSigilDef } from "@pizzapi/protocol";
import { matchesViewerGeneration } from "@/lib/viewer-switch";

/**
 * Service state cached directly on the socket object so it is available
 * before React effects mount (see race-condition note above).
 */
interface ServiceCacheFields {
    __serviceIds?: string[];
    __disabledServiceIds?: string[];
    __panels?: ServicePanelInfo[];
    __triggerDefs?: ServiceTriggerDef[];
    __sigilDefs?: ServiceSigilDef[];
    __sessionModes?: ServiceModeDef[];
    __viewerSwitchGeneration?: number;
}

type CachedSocket = Socket & ServiceCacheFields;

/** View a socket as carrying the optional cache fields (all optional, so this is a safe widening). */
function cache(socket: Socket): CachedSocket {
    return socket as CachedSocket;
}

/** Apply a delta to the socket's cached service state in-place. */
function applyDeltaToSocket(socket: Socket, delta: ServiceAnnounceDelta): void {
    // Service IDs
    const ids: string[] = cache(socket).__serviceIds ?? [];
    const removedIds = new Set(delta.removed.serviceIds);
    const filtered = ids.filter((id) => !removedIds.has(id));
    cache(socket).__serviceIds = [...filtered, ...delta.added.serviceIds];

    // Panels (keyed by serviceId)
    const panels: ServicePanelInfo[] = cache(socket).__panels ?? [];
    const removedPanels = new Set(delta.removed.panels);
    const updatedPanelMap = new Map(delta.updated.panels.map((p) => [p.serviceId, p]));
    const newPanels = panels
        .filter((p) => !removedPanels.has(p.serviceId))
        .map((p) => updatedPanelMap.get(p.serviceId) ?? p);
    cache(socket).__panels = [...newPanels, ...delta.added.panels];

    // Trigger defs (keyed by type)
    const triggers: ServiceTriggerDef[] = cache(socket).__triggerDefs ?? [];
    const removedTriggers = new Set(delta.removed.triggerDefs);
    const updatedTriggerMap = new Map(delta.updated.triggerDefs.map((t) => [t.type, t]));
    const newTriggers = triggers
        .filter((t) => !removedTriggers.has(t.type))
        .map((t) => updatedTriggerMap.get(t.type) ?? t);
    cache(socket).__triggerDefs = [...newTriggers, ...delta.added.triggerDefs];

    // Sigil defs (keyed by type)
    const sigils: ServiceSigilDef[] = cache(socket).__sigilDefs ?? [];
    const removedSigils = new Set(delta.removed.sigilDefs);
    const updatedSigilMap = new Map(delta.updated.sigilDefs.map((s) => [s.type, s]));
    const newSigils = sigils
        .filter((s) => !removedSigils.has(s.type))
        .map((s) => updatedSigilMap.get(s.type) ?? s);
    cache(socket).__sigilDefs = [...newSigils, ...delta.added.sigilDefs];

    const modes: ServiceModeDef[] = cache(socket).__sessionModes ?? [];
    const removedModes = new Set(delta.removed.sessionModes ?? []);
    const updatedModeMap = new Map((delta.updated.sessionModes ?? []).map((m) => [m.id, m]));
    cache(socket).__sessionModes = [...modes.filter((m) => !removedModes.has(m.id)).map((m) => updatedModeMap.get(m.id) ?? m), ...(delta.added.sessionModes ?? [])];
}

/**
 * Call this synchronously right after creating the viewer socket.
 * Attaches a persistent listener that captures service_announce events
 * so they're available before any React hooks mount.
 */
export function attachServiceAnnounceListener(socket: Socket): void {
    socket.on("service_announce", (data: ServiceAnnounceData & { generation?: number }) => {
        const currentGeneration = cache(socket).__viewerSwitchGeneration;
        if (!matchesViewerGeneration(currentGeneration, data.generation)) {
            return;
        }
        cache(socket).__serviceIds = data.serviceIds;
        cache(socket).__disabledServiceIds = data.disabledServiceIds ?? [];
        cache(socket).__panels = data.panels;
        cache(socket).__triggerDefs = data.triggerDefs;
        cache(socket).__sigilDefs = data.sigilDefs;
        cache(socket).__sessionModes = data.sessionModes ?? [];
    });
    socket.on("service_announce_delta", (data: ServiceAnnounceDelta & { generation?: number }) => {
        const currentGeneration = cache(socket).__viewerSwitchGeneration;
        if (!matchesViewerGeneration(currentGeneration, data.generation)) {
            return;
        }
        applyDeltaToSocket(socket, data);
    });
    socket.on("disconnect", () => {
        cache(socket).__serviceIds = undefined;
        cache(socket).__disabledServiceIds = undefined;
        cache(socket).__panels = undefined;
        cache(socket).__triggerDefs = undefined;
        cache(socket).__sigilDefs = undefined;
        cache(socket).__sessionModes = undefined;
    });
}

/**
 * Copy service IDs and panel info from a previous viewer socket onto a new one.
 * Used during same-runner session switches so useRunnerServices doesn't flash
 * to empty while waiting for the new socket's service_announce event.
 */
export function seedServiceCache(newSocket: Socket, prevSocket: Socket | null): void {
    if (!prevSocket) return;
    const ids = cache(prevSocket).__serviceIds;
    const disabledIds = cache(prevSocket).__disabledServiceIds;
    const panels = cache(prevSocket).__panels;
    const triggerDefs = cache(prevSocket).__triggerDefs;
    const sigilDefs = cache(prevSocket).__sigilDefs;
    const sessionModes = cache(prevSocket).__sessionModes;
    if (ids) cache(newSocket).__serviceIds = ids;
    if (disabledIds) cache(newSocket).__disabledServiceIds = disabledIds;
    if (panels) cache(newSocket).__panels = panels;
    if (triggerDefs) cache(newSocket).__triggerDefs = triggerDefs;
    if (sigilDefs) cache(newSocket).__sigilDefs = sigilDefs;
    if (sessionModes) cache(newSocket).__sessionModes = sessionModes;
}

export function setViewerSwitchGeneration(socket: Socket, generation: number): void {
    cache(socket).__viewerSwitchGeneration = generation;
}

/** Read any already-captured service IDs from the socket. */
function getEagerServiceIds(socket: Socket | null): Set<string> {
    const ids = socket ? cache(socket).__serviceIds : undefined;
    return ids ? new Set(ids) : new Set();
}

/** Read any already-captured disabled service IDs from the socket. */
function getEagerDisabledServiceIds(socket: Socket | null): Set<string> {
    const ids = socket ? cache(socket).__disabledServiceIds : undefined;
    return ids ? new Set(ids) : new Set();
}

/** Read any already-captured panels from the socket. */
function getEagerPanels(socket: Socket | null): ServicePanelInfo[] {
    return (socket ? cache(socket).__panels : undefined) ?? [];
}

/** Read any already-captured trigger defs from the socket. */
function getEagerTriggerDefs(socket: Socket | null): ServiceTriggerDef[] {
    return (socket ? cache(socket).__triggerDefs : undefined) ?? [];
}

/** Read any already-captured sigil defs from the socket. */
function getEagerSigilDefs(socket: Socket | null): ServiceSigilDef[] {
    return (socket ? cache(socket).__sigilDefs : undefined) ?? [];
}
function getEagerSessionModes(socket: Socket | null): ServiceModeDef[] {
    return (socket ? cache(socket).__sessionModes : undefined) ?? [];
}

export interface RunnerServicesState {
    services: Set<string>;
    disabledServices: Set<string>;
    panels: ServicePanelInfo[];
    triggerDefs: ServiceTriggerDef[];
    sigilDefs: ServiceSigilDef[];
    sessionModes: ServiceModeDef[];
}

function hasRunnerServiceMetadata(runnerInfo: RunnerInfo | null | undefined): boolean {
    return !!runnerInfo && (
        (runnerInfo.serviceIds?.length ?? 0) > 0 ||
        (runnerInfo.disabledServiceIds?.length ?? 0) > 0 ||
        (runnerInfo.panels?.length ?? 0) > 0 ||
        (runnerInfo.triggerDefs?.length ?? 0) > 0 ||
        (runnerInfo.sigilDefs?.length ?? 0) > 0 ||
        (runnerInfo.sessionModes?.length ?? 0) > 0
    );
}

export function runnerInfoToServices(runnerInfo: RunnerInfo | null | undefined): RunnerServicesState {
    return {
        services: new Set(runnerInfo?.serviceIds ?? []),
        disabledServices: new Set(runnerInfo?.disabledServiceIds ?? []),
        panels: runnerInfo?.panels ?? [],
        triggerDefs: runnerInfo?.triggerDefs ?? [],
        sigilDefs: runnerInfo?.sigilDefs ?? [],
        sessionModes: runnerInfo?.sessionModes ?? [],
    };
}

export function useRunnerServices(socket: Socket | null, runnerInfo: RunnerInfo | null = null): RunnerServicesState {
    const initialFromRunner = hasRunnerServiceMetadata(runnerInfo) ? runnerInfoToServices(runnerInfo) : null;
    const [services, setServices] = useState<Set<string>>(() => initialFromRunner?.services ?? getEagerServiceIds(socket));
    const [disabledServices, setDisabledServices] = useState<Set<string>>(() => initialFromRunner?.disabledServices ?? getEagerDisabledServiceIds(socket));
    const [panels, setPanels] = useState<ServicePanelInfo[]>(() => initialFromRunner?.panels ?? getEagerPanels(socket));
    const [triggerDefs, setTriggerDefs] = useState<ServiceTriggerDef[]>(() => initialFromRunner?.triggerDefs ?? getEagerTriggerDefs(socket));
    const [sigilDefs, setSigilDefs] = useState<ServiceSigilDef[]>(() => initialFromRunner?.sigilDefs ?? getEagerSigilDefs(socket));
    const [sessionModes, setSessionModes] = useState<ServiceModeDef[]>(() => initialFromRunner?.sessionModes ?? getEagerSessionModes(socket));
    const prevSocketRef = useRef(socket);

    if (socket !== prevSocketRef.current) {
        prevSocketRef.current = socket;
    }

    useEffect(() => {
        if (!socket) {
            setServices(new Set());
            setDisabledServices(new Set());
            setPanels([]);
            setTriggerDefs([]);
            setSigilDefs([]);
            setSessionModes([]);
            return;
        }

        // Prefer runner-feed metadata when available. The feed now carries the
        // runner's service metadata, so the viewer can join by runnerId instead
        // of depending on per-session service_announce copies.
        if (hasRunnerServiceMetadata(runnerInfo)) {
            const next = runnerInfoToServices(runnerInfo);
            setServices(next.services);
            setDisabledServices(next.disabledServices);
            setPanels(next.panels);
            setTriggerDefs(next.triggerDefs);
            setSigilDefs(next.sigilDefs);
            setSessionModes(next.sessionModes);
        } else if (runnerInfo === null) {
            // True non-runner/local session: clear stale runner service state.
            setServices(new Set());
            setDisabledServices(new Set());
            setPanels([]);
            setTriggerDefs([]);
            setSigilDefs([]);
            setSessionModes([]);
        } else {
            // Runner is known but feed metadata is not hydrated yet.
            // Read any eagerly captured announce data (including values seeded
            // via seedServiceCache for same-runner switches) and apply it
            // unconditionally. When the cache is empty, this clears stale
            // service state from the previous session instead of leaving old
            // panels/triggers visible.
            setServices(getEagerServiceIds(socket));
            setDisabledServices(getEagerDisabledServiceIds(socket));
            setPanels(getEagerPanels(socket));
            setTriggerDefs(getEagerTriggerDefs(socket));
            setSigilDefs(getEagerSigilDefs(socket));
            setSessionModes(getEagerSessionModes(socket));
        }

        const handleAnnounce = (data: ServiceAnnounceData & { generation?: number }) => {
            const currentGeneration = cache(socket).__viewerSwitchGeneration;
            if (!matchesViewerGeneration(currentGeneration, data.generation)) {
                return;
            }
            const useRunnerFeed = data._runnerRef === true && runnerInfo?.runnerId === data.runnerId && hasRunnerServiceMetadata(runnerInfo);
            const next = useRunnerFeed ? runnerInfoToServices(runnerInfo) : {
                services: new Set(data.serviceIds),
                disabledServices: new Set(data.disabledServiceIds ?? []),
                panels: data.panels ?? [],
                triggerDefs: data.triggerDefs ?? [],
                sigilDefs: data.sigilDefs ?? [],
                sessionModes: data.sessionModes ?? [],
            };
            setServices(next.services);
            setDisabledServices(next.disabledServices);
            setPanels(next.panels);
            setTriggerDefs(next.triggerDefs);
            setSigilDefs(next.sigilDefs);
            setSessionModes(next.sessionModes);
        };

        const handleDelta = (data: ServiceAnnounceDelta & { generation?: number }) => {
            const currentGeneration = cache(socket).__viewerSwitchGeneration;
            if (!matchesViewerGeneration(currentGeneration, data.generation)) {
                return;
            }
            // Apply the delta to socket cache (already done by the persistent listener)
            // and then read back the updated values for React state.
            const newIds = cache(socket).__serviceIds;
            const newDisabledIds = cache(socket).__disabledServiceIds;
            const newPanels = cache(socket).__panels;
            const newTriggerDefs = cache(socket).__triggerDefs;
            const newSigilDefs = cache(socket).__sigilDefs;
            const newSessionModes = cache(socket).__sessionModes;
            const useRunnerFeed = data._runnerRef === true && runnerInfo?.runnerId === data.runnerId && hasRunnerServiceMetadata(runnerInfo);
            if (useRunnerFeed) {
                const next = runnerInfoToServices(runnerInfo);
                setServices(next.services);
                setDisabledServices(next.disabledServices);
                setPanels(next.panels);
                setTriggerDefs(next.triggerDefs);
                setSigilDefs(next.sigilDefs);
                setSessionModes(next.sessionModes);
                return;
            }
            setServices(new Set(newIds ?? []));
            setDisabledServices(new Set(newDisabledIds ?? []));
            setPanels(newPanels ?? []);
            setTriggerDefs(newTriggerDefs ?? []);
            setSigilDefs(newSigilDefs ?? []);
            setSessionModes(newSessionModes ?? []);
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

    return { services, disabledServices, panels, triggerDefs, sigilDefs, sessionModes };
}
