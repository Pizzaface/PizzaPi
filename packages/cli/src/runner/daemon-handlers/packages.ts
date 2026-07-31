// Package manager socket.io handlers, split out of daemon.ts's runDaemon().
import type { Socket } from "socket.io-client";

async function withPackageManager<T extends Record<string, unknown>>(
    socket: any,
    requestId: string,
    fn: (pm: any) => Promise<T>,
): Promise<void> {
    try {
        const { DefaultPackageManager, SettingsManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
        const agentDir = getAgentDir();
        const cwd = process.cwd();
        const settingsManager = SettingsManager.create(cwd, agentDir);
        const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
        const result = await fn(packageManager);
        socket.emit("file_result", { requestId, ok: true, ...result });
    } catch (err) {
        socket.emit("file_result", { requestId, ok: false, message: err instanceof Error ? err.message : String(err) });
    }
}

export function registerPackagesHandlers(socket: Socket, isShuttingDown: () => boolean): void {
    socket.on("packages_list", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data?.requestId;
        await withPackageManager(socket, requestId, async (packageManager) => {
            const packages = packageManager.listConfiguredPackages();
            return { packages, message: `Found ${packages.length} package(s)` };
        });
    });

    socket.on("packages_install", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data?.requestId;
        const source = data?.source;
        const isLocal = data?.local === true;

        if (!source || typeof source !== "string") {
            socket.emit("file_result", {
                requestId,
                ok: false,
                message: "Missing or invalid package source",
            });
            return;
        }

        await withPackageManager(socket, requestId, async (packageManager) => {
            await packageManager.install(source, { local: isLocal });
            const added = packageManager.addSourceToSettings(source, { local: isLocal });
            if (!added) {
                throw new Error(`Failed to add package ${source} to settings`);
            }
            return { message: `Package ${source} installed successfully` };
        });
    });

    socket.on("packages_remove", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data?.requestId;
        const source = data?.source;
        const isLocal = data?.local === true;

        if (!source || typeof source !== "string") {
            socket.emit("file_result", {
                requestId,
                ok: false,
                message: "Missing or invalid package source",
            });
            return;
        }

        await withPackageManager(socket, requestId, async (packageManager) => {
            await packageManager.remove(source, { local: isLocal });
            const removed = packageManager.removeSourceFromSettings(source, { local: isLocal });
            if (!removed) {
                throw new Error(`Package ${source} not found in settings`);
            }
            return { message: `Package ${source} removed successfully` };
        });
    });

    socket.on("packages_update", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data?.requestId;
        const source = data?.source; // Optional: update specific package

        await withPackageManager(socket, requestId, async (packageManager) => {
            await packageManager.update(source);
            return {
                message: source
                    ? `Package ${source} updated successfully`
                    : "All packages updated successfully",
            };
        });
    });
}
