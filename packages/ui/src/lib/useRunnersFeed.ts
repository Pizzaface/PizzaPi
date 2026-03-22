import * as React from "react";
import { io, type Socket } from "socket.io-client";
import type {
    RunnersServerToClientEvents,
    RunnersClientToServerEvents,
    RunnerInfo,
} from "@pizzapi/protocol";
import { getSocketIOBase } from "./relay.js";

export type RunnersFeedStatus = "connecting" | "connected" | "disconnected";

export interface RunnersFeedState {
    runners: RunnerInfo[];
    status: RunnersFeedStatus;
}

/**
 * Subscribe to the /runners Socket.IO namespace.
 * Returns the live runner list and connection status.
 * Call this hook ONCE in App.tsx and pass runners down as props —
 * do not call it in child components to avoid duplicate socket connections.
 */
export function useRunnersFeed(): RunnersFeedState {
    const [runners, setRunners] = React.useState<RunnerInfo[]>([]);
    const [status, setStatus] = React.useState<RunnersFeedStatus>("connecting");

    React.useEffect(() => {
        const base = getSocketIOBase();
        const socket: Socket<RunnersServerToClientEvents, RunnersClientToServerEvents> = io(
            base ? `${base}/runners` : "/runners",
            { withCredentials: true },
        );

        socket.on("connect", () => setStatus("connected"));
        socket.on("disconnect", () => setStatus("disconnected"));
        socket.on("connect_error", () => setStatus("disconnected"));

        socket.on("runners", ({ runners: list }) => {
            setRunners(list);
        });

        socket.on("runner_added", (incoming) => {
            setRunners(prev => {
                const idx = prev.findIndex(r => r.runnerId === incoming.runnerId);
                if (idx === -1) return [...prev, incoming];
                const next = [...prev];
                next[idx] = incoming;
                return next;
            });
        });

        socket.on("runner_removed", ({ runnerId }) => {
            setRunners(prev => prev.filter(r => r.runnerId !== runnerId));
        });

        socket.on("runner_updated", (incoming) => {
            setRunners(prev => {
                const idx = prev.findIndex(r => r.runnerId === incoming.runnerId);
                if (idx === -1) return prev; // unknown runner — ignore
                const next = [...prev];
                next[idx] = incoming;
                return next;
            });
        });

        return () => {
            socket.disconnect();
        };
    }, []);

    return { runners, status };
}
