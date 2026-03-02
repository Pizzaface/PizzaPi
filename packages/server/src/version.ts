import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadVersion(): string {
    try {
        const pkgPath = resolve(__dirname, "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return pkg.version ?? "unknown";
    } catch {
        return "unknown";
    }
}

export const SERVER_VERSION = loadVersion();
