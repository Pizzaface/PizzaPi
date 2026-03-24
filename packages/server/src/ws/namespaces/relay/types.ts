// Shared type definitions for the relay namespace modules.

import type { Socket } from "socket.io";
import type {
    RelayClientToServerEvents,
    RelayServerToClientEvents,
    RelayInterServerEvents,
    RelaySocketData,
} from "@pizzapi/protocol";

export type RelaySocket = Socket<
    RelayClientToServerEvents,
    RelayServerToClientEvents,
    RelayInterServerEvents,
    RelaySocketData
>;
