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
import type { ServiceAnnounceData, ServicePanelInfo } from "@pizzapi/protocol";

const SERVICE_IDS_KEY = "__serviceIds" as const;
const PANELS_KEY = "__panels" as const;

/**
 * Call this synchronously right after creating the viewer socket.
 * Attaches a persistent listener that captures service_announce events
 * so they're available before any React hooks mount.
 */
export function attachServiceAnnounceListener(socket: Socket): void {
    socket.on("service_announce", (data: ServiceAnnounceData) => {
        (socket as any)[SERVICE_IDS_KEY] = data.serviceIds;
        (socket as any)[PANELS_KEY] = data.panels;
    });
    socket.on("disconnect", () => {
        (socket as any)[SERVICE_IDS_KEY] = undefined;
        (socket as any)[PANELS_KEY] = undefined;
    });
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

export interface RunnerServicesState {
    services: Set<string>;
    panels: ServicePanelInfo[];
}

export function useRunnerServices(socket: Socket | null): RunnerServicesState {
    const [services, setServices] = useState<Set<string>>(() => getEagerServiceIds(socket));
    const [panels, setPanels] = useState<ServicePanelInfo[]>(() => getEagerPanels(socket));
    const prevSocketRef = useRef(socket);

    // When the socket changes, eagerly read any cached announce
    if (socket !== prevSocketRef.current) {
        prevSocketRef.current = socket;
        const eager = getEagerServiceIds(socket);
        if (eager.size > 0 || services.size > 0) {
            // Can't call setState during render in strict mode without this pattern
            // but since we're comparing refs it's fine — this is a derived-state reset
        }
    }

    useEffect(() => {
        if (!socket) {
            setServices(new Set());
            setPanels([]);
            return;
        }

        // Read eagerly in case announce arrived before this effect ran
        // (e.g. seeded via seedServiceCache for same-runner switches).
        const cached = getEagerServiceIds(socket);
        if (cached.size > 0) {
            setServices(cached);
        }
        const cachedPanels = getEagerPanels(socket);
        if (cachedPanels.length > 0) {
            setPanels(cachedPanels);
        }

        const handleAnnounce = (data: ServiceAnnounceData) => {
            setServices(new Set(data.serviceIds));
            setPanels(data.panels ?? []);
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

        return () => {
            socket.off("service_announce", handleAnnounce);
        };
    }, [socket]);

    return { services, panels };
}
