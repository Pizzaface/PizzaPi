import { useEffect, useCallback, useRef, useState } from "react";
import { useViewerSocket } from "@/lib/viewer-socket-context";
import type { ServiceEnvelope } from "@pizzapi/protocol";

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
    const [available, setAvailable] = useState(false);
    const onMessageRef = useRef(options.onMessage);
    onMessageRef.current = options.onMessage;

    useEffect(() => {
        if (!socket) {
            setAvailable(false);
            return;
        }

        const handleMessage = (envelope: ServiceEnvelope) => {
            if (envelope.serviceId !== serviceId) return;
            onMessageRef.current?.(envelope.type, envelope.payload as TPayload, envelope.requestId);
        };

        const handleAnnounce = (data: { serviceIds: string[] }) => {
            setAvailable(data.serviceIds.includes(serviceId));
        };

        const handleDisconnect = () => setAvailable(false);
        const handleConnect = () => setAvailable(false);

        socket.on("service_message", handleMessage);
        socket.on("service_announce", handleAnnounce);
        socket.on("disconnect", handleDisconnect);
        socket.on("connect", handleConnect);

        return () => {
            socket.off("service_message", handleMessage);
            socket.off("service_announce", handleAnnounce);
            socket.off("disconnect", handleDisconnect);
            socket.off("connect", handleConnect);
            setAvailable(false);
        };
    }, [socket, serviceId]);

    const send = useCallback((type: string, payload: TSend, requestId?: string) => {
        if (!socket) return;
        const envelope: ServiceEnvelope = { serviceId, type, payload, requestId };
        socket.emit("service_message", envelope);
    }, [socket, serviceId]);

    return { send, available };
}
