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

function safeUsername(): string | undefined {
    // os.userInfo() throws when the current UID has no /etc/passwd entry
    // (common in minimal containers). Account-specific candidates are a
    // bonus on top of the HOME/XDG/LOCALAPPDATA-derived paths below, so
    // never let this abort resolution.
    try {
        return os.userInfo().username;
    } catch {
        return undefined;
    }
}

function candidateBrowserPaths(): string[] {
    const home = os.homedir();
    const username = safeUsername();

    if (process.platform === "darwin") {
        return [
            path.join(home, "Library", "Caches", "ms-playwright"),
            username ? path.join("/Users", username, "Library", "Caches", "ms-playwright") : "",
        ].filter(Boolean);
    }

    if (process.platform === "win32") {
        return [
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : "",
            username ? path.join("C:\\Users", username, "AppData", "Local", "ms-playwright") : "",
        ].filter(Boolean);
    }

    return [
        process.env.XDG_CACHE_HOME ? path.join(process.env.XDG_CACHE_HOME, "ms-playwright") : "",
        path.join(home, ".cache", "ms-playwright"),
        username ? path.join("/home", username, ".cache", "ms-playwright") : "",
        username === "root" ? path.join("/root", ".cache", "ms-playwright") : "",
    ].filter(Boolean);
}

export function ensurePlaywrightBrowsersPath(): void {
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;

    const browsersPath = candidateBrowserPaths().find(hasChromiumBrowser);
    if (browsersPath) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
}
