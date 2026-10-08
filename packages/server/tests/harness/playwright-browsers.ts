import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function hasChromiumBrowser(dir: string): boolean {
    try {
        return existsSync(dir) && readdirSync(dir).some((entry) => entry.startsWith("chromium"));
    } catch {
        return false;
    }
}

function candidateBrowserPaths(): string[] {
    const home = os.homedir();
    const username = os.userInfo().username;

    if (process.platform === "darwin") {
        return [
            path.join(home, "Library", "Caches", "ms-playwright"),
            path.join("/Users", username, "Library", "Caches", "ms-playwright"),
        ];
    }

    if (process.platform === "win32") {
        return [
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : "",
            path.join("C:\\Users", username, "AppData", "Local", "ms-playwright"),
        ].filter(Boolean);
    }

    return [
        process.env.XDG_CACHE_HOME ? path.join(process.env.XDG_CACHE_HOME, "ms-playwright") : "",
        path.join(home, ".cache", "ms-playwright"),
        path.join("/home", username, ".cache", "ms-playwright"),
        username === "root" ? path.join("/root", ".cache", "ms-playwright") : "",
    ].filter(Boolean);
}

export function ensurePlaywrightBrowsersPath(): void {
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;

    const browsersPath = candidateBrowserPaths().find(hasChromiumBrowser);
    if (browsersPath) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
}
