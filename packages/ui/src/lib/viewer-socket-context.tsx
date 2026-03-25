import { createContext, useContext } from "react";
import type { Socket } from "socket.io-client";
import type { ViewerServerToClientEvents, ViewerClientToServerEvents } from "@pizzapi/protocol";

export type ViewerSocket = Socket<ViewerServerToClientEvents, ViewerClientToServerEvents>;

export const ViewerSocketContext = createContext<ViewerSocket | null>(null);

export function useViewerSocket(): ViewerSocket | null {
    return useContext(ViewerSocketContext);
}
