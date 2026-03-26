import { createContext, useContext } from "react";
import type { Socket } from "socket.io-client";
import type { HubServerToClientEvents, HubClientToServerEvents } from "@pizzapi/protocol";

export type HubSocket = Socket<HubServerToClientEvents, HubClientToServerEvents>;

export const HubSocketContext = createContext<HubSocket | null>(null);

export function useHubSocket(): HubSocket | null {
    return useContext(HubSocketContext);
}
