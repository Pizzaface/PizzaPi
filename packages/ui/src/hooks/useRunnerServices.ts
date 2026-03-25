/**
 * Track which runner services are available via service_announce events.
 * Returns a Set<string> of service IDs that updates reactively.
 *
 * Accepts the viewer socket directly (rather than reading from context)
 * because App.tsx creates the Provider and calls this hook in the same
 * component — context isn't available until the Provider renders in JSX.
 */
import { useState, useEffect } from "react";
import type { Socket } from "socket.io-client";

export function useRunnerServices(socket: Socket | null): Set<string> {
    const [services, setServices] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (!socket) {
            setServices(new Set());
            return;
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
