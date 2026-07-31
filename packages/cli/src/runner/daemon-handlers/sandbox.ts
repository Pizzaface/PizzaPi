// Sandbox status/config socket.io handlers, split out of daemon.ts's runDaemon().
import type { Socket } from "socket.io-client";

export function registerSandboxHandlers(socket: Socket, isShuttingDown: () => boolean): void {
    socket.on("sandbox_get_status", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId;
        try {
            // Read sandbox config from disk — the daemon process does NOT
            // run inside a sandbox itself, so process-local sandbox state
            // (getSandboxMode, isSandboxActive, getViolations) would always
            // return defaults.  The persisted config is the source of truth
            // for what workers will use.
            const { loadConfig, resolveSandboxConfig, loadGlobalConfig } = await import("../../config.js");
            // Use only the global config for resolution — the daemon
            // process CWD may contain project-local overrides that
            // should not influence the global settings editor.
            const globalCfg = loadGlobalConfig();
            const globalOnlyConfig = loadConfig(process.cwd());
            // Override sandbox with global-only to prevent project-local
            // settings from leaking into the status response.
            globalOnlyConfig.sandbox = globalCfg.sandbox ?? {};
            const resolvedConfig = resolveSandboxConfig(process.cwd(), globalOnlyConfig);
            const mode = resolvedConfig.mode ?? "none";
            // The daemon can't know if a worker sandbox is actively
            // enforcing right now — report that a non-"none" mode is
            // *configured*, not that enforcement is proven active.
            const configured = mode !== "none";
            socket.emit("file_result", {
                requestId,
                ok: true,
                mode,
                active: configured,
                configured,
                platform: process.platform,
                violations: 0,
                recentViolations: [],
                config: resolvedConfig,
                // Send only the *global* raw config so the UI editor
                // doesn't leak project-local overrides into global config
                // when saving.
                rawConfig: loadGlobalConfig().sandbox ?? {},
            });
        } catch (err) {
            socket.emit("file_result", {
                requestId,
                ok: false,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    });

    socket.on("sandbox_update_config", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId;
        const body = data.config;
        try {
            if (!body || typeof body !== "object") {
                socket.emit("file_result", { requestId, ok: false, message: "Invalid sandbox config body" });
                return;
            }
            const validModes = ["none", "basic", "full"];
            if (body.mode !== undefined && !validModes.includes(body.mode)) {
                socket.emit("file_result", { requestId, ok: false, message: `Invalid mode "${body.mode}"` });
                return;
            }
            const { saveGlobalConfig, loadConfig, resolveSandboxConfig, loadGlobalConfig } = await import("../../config.js");
            // Merge with existing global sandbox config so UI-unmanaged
            // fields (ignoreViolations, allowUnixSockets, proxy ports,
            // allowGitConfig, etc.) are preserved across saves.
            const existingSandbox = loadGlobalConfig().sandbox ?? {} as Record<string, any>;
            // Deep-merge nested objects (filesystem, network) so that
            // sub-fields not managed by the UI (e.g. allowGitConfig,
            // allowUnixSockets, proxy ports) are preserved.
            const merged: Record<string, any> = { ...existingSandbox };
            for (const [key, value] of Object.entries(body)) {
                if (value && typeof value === "object" && !Array.isArray(value)
                    && merged[key] && typeof merged[key] === "object" && !Array.isArray(merged[key])) {
                    merged[key] = { ...merged[key], ...value };
                } else {
                    merged[key] = value;
                }
            }
            saveGlobalConfig({ sandbox: merged });
            const newConfig = loadConfig(process.cwd());
            const resolved = resolveSandboxConfig(process.cwd(), newConfig);
            socket.emit("file_result", {
                requestId,
                ok: true,
                saved: true,
                resolvedConfig: resolved,
                message: "Changes will apply on next session start.",
            });
        } catch (err) {
            socket.emit("file_result", {
                requestId,
                ok: false,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    });
}
