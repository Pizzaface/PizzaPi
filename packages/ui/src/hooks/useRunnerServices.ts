/**
 * Track which runner services are available via service_announce events.
 * Returns a Set<string> of service IDs that updates reactively.
 */
import { useState, useEffect } from "react";
import { useViewerSocket } from "@/lib/viewer-socket-context";

export function useRunnerServices(): Set<string> {
    const socket = useViewerSocket();
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
