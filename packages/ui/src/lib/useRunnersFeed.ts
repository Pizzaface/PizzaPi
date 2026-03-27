import * as React from "react";
import { io, type Socket } from "socket.io-client";
import type {
    RunnersServerToClientEvents,
    RunnersClientToServerEvents,
    RunnerInfo,
} from "@pizzapi/protocol";
import { SOCKET_PROTOCOL_VERSION } from "@pizzapi/protocol";
import { getSocketIOBase } from "./relay.js";
import { upsert } from "./runnerHelpers.js";

declare const __PIZZAPI_UI_VERSION__: string;
const UI_VERSION = typeof __PIZZAPI_UI_VERSION__ === "string" && __PIZZAPI_UI_VERSION__.trim()
    ? __PIZZAPI_UI_VERSION__.trim()
    : "0.0.0";

export type RunnersFeedStatus = "connecting" | "connected" | "disconnected";

export interface RunnersFeedState {
    runners: RunnerInfo[];
    status: RunnersFeedStatus;
}

export interface UseRunnersFeedOptions {
    /**
     * When false, the socket is not created (or is disconnected if it was).
     * State is cleared to empty / "disconnected".
     * Default: true.
     */
    enabled?: boolean;
    /**
     * The authenticated user's ID. When this changes (e.g. a different user
     * logs in on the same tab), the old socket is torn down and a new one is
     * created so the server places the new socket in the correct user room.
     */
    userId?: string | null;
}

/**
 * Subscribe to the /runners Socket.IO namespace.
 * Returns the live runner list and connection status.
 * Call this hook ONCE in App.tsx and pass runners down as props —
 * do not call it in child components to avoid duplicate socket connections.
 *
 * Pass `enabled` and `userId` so the hook reconnects when auth changes:
 *   - disabled (logged out): socket is disconnected, state cleared
 *   - userId changes (different user logs in): old socket torn down, new one created
 */
export function useRunnersFeed(options: UseRunnersFeedOptions = {}): RunnersFeedState {
    const { enabled = true, userId } = options;
    const [runners, setRunners] = React.useState<RunnerInfo[]>([]);
    const [status, setStatus] = React.useState<RunnersFeedStatus>("connecting");
    // Track the previous userId so we can clear stale runners before reconnecting
    // under a different account. Without this, old-account runner metadata stays
    // visible until the new socket delivers its first snapshot.
    const prevUserIdRef = React.useRef<string | null | undefined>(userId);

    React.useEffect(() => {
        if (!enabled) {
            setRunners([]);
            setStatus("disconnected");
            prevUserIdRef.current = userId;
            return;
        }

        // Clear stale runners immediately when the user identity changes so
        // the previous user's runner list never leaks into the new session.
        if (userId !== prevUserIdRef.current) {
            setRunners([]);
        }
        prevUserIdRef.current = userId;

        // Mark as connecting immediately so consumers don't treat the feed as
        // "fully loaded with zero runners" during the window between enabled
        // flipping true and the socket firing its "connect" event.
        setStatus("connecting");

        const base = getSocketIOBase();
        const socket: Socket<RunnersServerToClientEvents, RunnersClientToServerEvents> = io(
            base ? `${base}/runners` : "/runners",
            {
                withCredentials: true,
                auth: {
                    protocolVersion: SOCKET_PROTOCOL_VERSION,
                    clientVersion: UI_VERSION,
                },
            },
        );

        socket.on("connect", () => setStatus("connected"));
        socket.on("disconnect", () => setStatus("disconnected"));
        socket.on("connect_error", () => setStatus("disconnected"));

        socket.on("runners", ({ runners: list }) => {
            setRunners(list);
        });

        socket.on("runner_added", (incoming) => {
            setRunners(prev => upsert(prev, incoming));
        });

        socket.on("runner_removed", ({ runnerId }) => {
            setRunners(prev => prev.filter(r => r.runnerId !== runnerId));
        });

        socket.on("runner_updated", (incoming) => {
            // Upsert: apply the update even if the initial snapshot hasn't arrived yet.
            // This prevents updates from being silently dropped during the join→snapshot
            // window, where runner_updated can arrive before the runners snapshot.
            setRunners(prev => upsert(prev, incoming));
        });

        return () => {
            socket.disconnect();
        };
    // Re-run when auth changes: disabled → clear state; userId change → reconnect
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, userId]);

    return { runners, status };
}
