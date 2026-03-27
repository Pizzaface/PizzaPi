/**
 * PizzaPi startup migrations — consolidate agent data into flat ~/.pizzapi/.
 *
 * Called from both the daemon and interactive TUI on startup.
 * Idempotent — safe to call repeatedly.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("migrations");

/**
 * Migrate session & agent data into the flat ~/.pizzapi/ directory.
 *
 * Phase 1: ~/.pi/agent → ~/.pizzapi/  (legacy pi installs)
 * Phase 2: ~/.pizzapi/agent/ → ~/.pizzapi/  (pre-fix PizzaPi installs that
 *          had upstream's getAgentDir() returning ~/.pizzapi/agent/)
 *
 * A `.migrated` marker file is written to ~/.pizzapi/agent/ after phase 2
 * so we don't re-scan on every boot.
 */
export function migrateAgentDir(): void {
    const pizzapiDir = join(homedir(), ".pizzapi");
    const agentSubdir = join(pizzapiDir, "agent");
    const markerFile = join(agentSubdir, ".migrated");

    // ── Phase 1: ~/.pi/agent → ~/.pizzapi/ ─────────────────────────────────
    const piAgentDir = join(homedir(), ".pi", "agent");
    if (existsSync(piAgentDir)) {
        // Only migrate if we haven't already (sessions dir doesn't exist at root)
        if (!existsSync(join(pizzapiDir, "sessions"))) {
            try {
                mergeDir(piAgentDir, pizzapiDir);
                log.info("Migrated session data from ~/.pi/agent into ~/.pizzapi");
            } catch (e: any) {
                log.warn(`Failed to migrate ~/.pi/agent: ${e.message}`);
            }
        }
    }

    // ── Phase 2: ~/.pizzapi/agent/ → ~/.pizzapi/ ───────────────────────────
    // Earlier PizzaPi versions (and the upstream lib) stored sessions, auth,
    // bin, and usage.db under ~/.pizzapi/agent/. Now that getAgentDir() returns
    // ~/.pizzapi/ directly, consolidate everything into the flat structure.
    if (existsSync(agentSubdir) && !existsSync(markerFile)) {
        try {
            mergeDir(agentSubdir, pizzapiDir);
            // Write marker so we don't re-scan
            mkdirSync(agentSubdir, { recursive: true });
            Bun.write(markerFile, new Date().toISOString());
            log.info("Consolidated ~/.pizzapi/agent/ into ~/.pizzapi/");
        } catch (e: any) {
            log.warn(`Failed to consolidate ~/.pizzapi/agent/: ${e.message}`);
        }
    }
}

/**
 * Recursively merge `src` into `dst`, skipping files that already exist in dst.
 * Does not delete src — caller decides cleanup.
 */
export function mergeDir(src: string, dst: string): void {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
        // Skip the .migrated marker and .DS_Store
        if (entry === ".migrated" || entry === ".DS_Store") continue;
        const srcPath = join(src, entry);
        const dstPath = join(dst, entry);
        const stat = statSync(srcPath);
        if (stat.isDirectory()) {
            // Recursively merge subdirectories (e.g. sessions/*)
            mergeDir(srcPath, dstPath);
        } else if (!existsSync(dstPath)) {
            // Move file — try rename first, fall back to copy
            try {
                renameSync(srcPath, dstPath);
            } catch {
                cpSync(srcPath, dstPath);
            }
        }
        // If dst already has the file, skip (don't overwrite)
    }
}
