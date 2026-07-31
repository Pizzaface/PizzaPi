// Model listing socket.io handler, split out of daemon.ts's runDaemon().
// `listConfiguredModels` stays owned by daemon.ts (shared with session-analysis's
// context-window lookup) and is passed in rather than duplicated here.
import type { Socket } from "socket.io-client";
import type { SessionModelEntry } from "../../session-models-cache.js";

export function registerModelsHandlers(
    socket: Socket,
    isShuttingDown: () => boolean,
    listConfiguredModels: (cwd?: string) => Promise<SessionModelEntry[]>,
): void {
    socket.on("list_models", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data?.requestId;
        try {
            const models = await listConfiguredModels(process.cwd());
            socket.emit("models_list", { requestId, models });
        } catch (e: any) {
            socket.emit("models_list", { requestId, models: [], error: e.message ?? "Failed to list models" });
        }
    });
}
