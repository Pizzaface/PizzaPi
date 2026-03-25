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

const SERVICE_IDS_KEY = "__serviceIds" as const;

/**
 * Call this synchronously right after creating the viewer socket.
 * Attaches a persistent listener that captures service_announce events
 * so they're available before any React hooks mount.
 */
export function attachServiceAnnounceListener(socket: Socket): void {
    socket.on("service_announce", (data: { serviceIds: string[] }) => {
        (socket as any)[SERVICE_IDS_KEY] = data.serviceIds;
    });
    socket.on("disconnect", () => {
        (socket as any)[SERVICE_IDS_KEY] = undefined;
    });
}

/** Read any already-captured service IDs from the socket. */
function getEagerServiceIds(socket: Socket | null): Set<string> {
    const ids = socket ? (socket as any)[SERVICE_IDS_KEY] as string[] | undefined : undefined;
    return ids ? new Set(ids) : new Set();
}

export function useRunnerServices(socket: Socket | null): Set<string> {
    const [services, setServices] = useState<Set<string>>(() => getEagerServiceIds(socket));
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
            return;
        }

        // Read eagerly in case announce arrived before this effect ran
        const cached = getEagerServiceIds(socket);
        if (cached.size > 0) {
            setServices(cached);
        }

        const handleAnnounce = (data: { serviceIds: string[] }) => {
            setServices(new Set(data.serviceIds));
        };
        const handleDisconnect = () => setServices(new Set());

        socket.on("service_announce", handleAnnounce);
        socket.on("disconnect", handleDisconnect);

        return () => {
            socket.off("service_announce", handleAnnounce);
            socket.off("disconnect", handleDisconnect);
        };
    }, [socket]);

    return services;
}
