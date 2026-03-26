import { useEffect, useCallback, useRef, useState } from "react";
import { useViewerSocket } from "@/lib/viewer-socket-context";
import type { ServiceAnnounceData, ServiceEnvelope } from "@pizzapi/protocol";

// Re-export so existing consumers that import from this module still work.
export { getEagerServiceAvailability } from "./service-availability";
import { getEagerServiceAvailability } from "./service-availability";

export interface ServiceChannelOptions<TPayload = unknown> {
    onMessage?: (type: string, payload: TPayload, requestId?: string) => void;
}

export interface ServiceChannel<TSend = unknown> {
    send: (type: string, payload: TSend, requestId?: string) => void;
    available: boolean;
}

export function useServiceChannel<TSend = unknown, TPayload = unknown>(
    serviceId: string,
    options: ServiceChannelOptions<TPayload> = {}
): ServiceChannel<TSend> {
    const socket = useViewerSocket();
    const [available, setAvailable] = useState(() => getEagerServiceAvailability(socket, serviceId));
    const onMessageRef = useRef(options.onMessage);
    onMessageRef.current = options.onMessage;

    useEffect(() => {
        if (!socket) {
            setAvailable(false);
            return;
        }

        setAvailable(getEagerServiceAvailability(socket, serviceId));

        const handleMessage = (envelope: ServiceEnvelope) => {
            if (envelope.serviceId !== serviceId) return;
            onMessageRef.current?.(envelope.type, envelope.payload as TPayload, envelope.requestId);
        };

        const handleAnnounce = (data: ServiceAnnounceData) => {
            setAvailable(data.serviceIds.includes(serviceId));
        };

        // NOTE: No handleDisconnect listener — we intentionally preserve
        // the previous `available` state when the socket disconnects during
        // a session switch. The old socket fires `disconnect` synchronously
        // before the new socket is set, which would flash available to false
        // and cause TunnelPanel to show "unavailable" briefly. Instead, we
        // only set available=false when the effect re-runs with socket===null
        // (handled above), and the new socket's service_announce will update
        // availability once it arrives.
        //
        // On reconnect (socket.io auto-reconnect within the same socket
        // instance), the server re-sends service_announce which updates
        // availability via handleAnnounce.

        socket.on("service_message", handleMessage);
        socket.on("service_announce", handleAnnounce);

        return () => {
            socket.off("service_message", handleMessage);
            socket.off("service_announce", handleAnnounce);
        };
    }, [socket, serviceId]);

    /**
     * Send a message to the service.
     *
     * **Important:** Only call `send` when `available === true`. The socket
     * may be disconnected or the service may not yet be registered when
     * `available` is `false`, so any message sent in that state will be
     * silently dropped. Consumers should gate all calls behind `if (available)`.
     */
    const send = useCallback((type: string, payload: TSend, requestId?: string) => {
        if (!socket) return;
        const envelope: ServiceEnvelope = { serviceId, type, payload, requestId };
        socket.emit("service_message", envelope);
    }, [socket, serviceId]);

    return { send, available };
}
