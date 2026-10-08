// Plugin listing socket.io handler, split out of daemon.ts's runDaemon().
import type { Socket } from "socket.io-client";
import { scanAllPluginInfo } from "../../plugins.js";
import { isCwdAllowed } from "../workspace.js";
import { runPluginCommandView } from "../../extensions/plugin-command.js";

export function registerPluginsHandlers(socket: Socket, isShuttingDown: () => boolean): void {
    socket.on("list_plugins", (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data?.requestId;
        // Use the provided cwd (e.g. session's working directory) if
        // available, otherwise fall back to the daemon's own cwd.
        // Validate against workspace roots to prevent arbitrary path scanning.
        const rawCwd = (typeof data?.cwd === "string" && data.cwd) ? data.cwd : undefined;
        if (rawCwd && !isCwdAllowed(rawCwd)) {
            socket.emit("plugins_list", { plugins: [], requestId, ok: false, message: "cwd outside allowed workspace roots" });
            return;
        }
        // Only include project-local plugins when an explicit session cwd
        // was provided AND it's within allowed workspace roots. Without an
        // explicit cwd this is a runner-level query — only global plugins.
        // When rawCwd is absent, pass undefined so marketplace discovery
        // skips project-scoped plugins and respects only user-level settings.
        const scanCwd = rawCwd ?? undefined;
        const includeLocal = !!rawCwd && isCwdAllowed(rawCwd);
        const plugins = scanAllPluginInfo(scanCwd, { includeProjectLocal: includeLocal });
        // Echo scoped flag so the server can skip cache updates for per-session scans
        socket.emit("plugins_list", { plugins, requestId, ...(rawCwd ? { scoped: true } : {}) });
    });

    // `/plugin` for the runner panel: same structured result the in-session
    // card renders. Refreshes the runner-wide plugin cache.
    // ponytail: marketplace git clones run synchronously on the daemon loop;
    // move to a child process if slow marketplaces start starving heartbeats.
    socket.on("plugin_command", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data?.requestId;
        const args = Array.isArray(data?.args) ? data.args.filter((a: unknown): a is string => typeof a === "string") : [];
        const cwd = typeof data?.cwd === "string" && data.cwd ? data.cwd : undefined;
        if (cwd && !isCwdAllowed(cwd)) {
            socket.emit("file_result", { requestId, ok: false, message: "cwd outside allowed workspace roots" });
            return;
        }
        const { output: _output, ...view } = await runPluginCommandView(args, cwd);
        socket.emit("file_result", { requestId, ok: true, ...view });
        // Unscoped runs ARE the global scan — refresh the runner-wide cache.
        if (!cwd) socket.emit("plugins_list", { plugins: view.overview.plugins });
        else if (view.changed) socket.emit("plugins_list", { plugins: scanAllPluginInfo(undefined, { includeProjectLocal: false }) });
    });
}
