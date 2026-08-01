/**
 * File-backed secrets for container/K8s deployments.
 *
 * Docker/K8s secrets are mounted as files, not env vars \u2014 these two helpers
 * bridge that gap without ever logging a credential value:
 *
 *   1. `expandFileBackedEnv` \u2014 `FOO_FILE=/path` \u2192 `FOO=<trimmed file contents>`,
 *      restricted to credential-shaped names so an unrelated `*_FILE` var
 *      (e.g. NTFY_AUTH_FILE pointing at a binary DB) is never touched.
 *   2. `seedAuthFileIfNeeded` \u2014 copies `PIZZAPI_AUTH_FILE` into the agent
 *      dir's auth.json on first boot, without ever clobbering an existing
 *      one (OAuth refresh writes back to it).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("secrets");

/** `<NAME>_FILE` is only expanded when `<NAME>` looks like a credential. */
function isCredentialShaped(name: string): boolean {
    return name.endsWith("_KEY") || name.endsWith("_TOKEN");
}

/**
 * Expand `<NAME>_FILE` env vars into `<NAME>` for credential-shaped names
 * (ends in `_API_KEY` / `_TOKEN` / `_KEY`, e.g. ANTHROPIC_API_KEY_FILE,
 * GH_TOKEN_FILE, PIZZAPI_API_KEY_FILE). Skips a name that's already set
 * (env wins) and any file that can't be read. Never logs values.
 */
export function expandFileBackedEnv(env: NodeJS.ProcessEnv = process.env): void {
    for (const key of Object.keys(env)) {
        if (!key.endsWith("_FILE")) continue;
        const name = key.slice(0, -"_FILE".length);
        if (!isCredentialShaped(name)) continue;
        if (env[name]) continue; // already set — wins
        const path = env[key];
        if (!path) continue;
        try {
            const contents = readFileSync(path, "utf-8").trim();
            if (!contents) continue;
            env[name] = contents;
            log.info(`${name} populated from ${path}`);
        } catch (err) {
            log.warn(`Could not read ${key}=${path}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

/**
 * Seed `<agentDir>/auth.json` from `PIZZAPI_AUTH_FILE` on first boot.
 * Never overwrites an existing auth.json — OAuth refresh writes back to it,
 * so clobbering on every restart would destroy refreshed tokens.
 */
export function seedAuthFileIfNeeded(agentDir: string, env: NodeJS.ProcessEnv = process.env): void {
    const src = env.PIZZAPI_AUTH_FILE;
    if (!src) return;
    const dest = join(agentDir, "auth.json");
    if (existsSync(dest)) {
        log.info(`auth.json already exists at ${dest} — keeping existing credentials (PIZZAPI_AUTH_FILE ignored)`);
        return;
    }
    if (!existsSync(src)) {
        log.warn(`PIZZAPI_AUTH_FILE=${src} is not readable — skipping seed`);
        return;
    }
    try {
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(dest, readFileSync(src, "utf-8"), { encoding: "utf-8", mode: 0o600 });
        log.info(`seeded auth.json from ${src}`);
    } catch (err) {
        log.warn(`Failed to seed auth.json from ${src}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
