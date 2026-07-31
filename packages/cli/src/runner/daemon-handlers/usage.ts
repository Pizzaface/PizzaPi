// Usage dashboard socket.io handler, split out of daemon.ts's runDaemon().
import type { Socket } from "socket.io-client";
import { getData as getUsageData } from "../../usage/index.js";
import type { UsageRange } from "../../usage/types.js";

export function registerUsageHandlers(socket: Socket, isShuttingDown: () => boolean): void {
    socket.on("get_usage", (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId ?? "";
        try {
            const range = (data.range as UsageRange) || "90d";
            const usageData = getUsageData(range);
            if (!usageData) {
                socket.emit("usage_error", {
                    requestId,
                    error: "Usage data not available yet — initial scan in progress",
                });
                return;
            }
            socket.emit("usage_data", { requestId, data: usageData });
        } catch (e: any) {
            socket.emit("usage_error", {
                requestId,
                error: e.message ?? "Unknown error",
            });
        }
    });
}
