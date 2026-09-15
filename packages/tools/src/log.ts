/**
 * Lightweight timestamped logger.
 *
 * Every message is prefixed with an ISO-8601 timestamp and a bracketed tag
 * so log files are correlatable and grep-friendly:
 *
 *   2026-03-26T10:30:00.123Z [health] Redis pub connected
 *   2026-03-26T10:30:00.456Z [sio/relay] session started sid=abc123
 *
 * Usage:
 *   import { createLogger } from "@pizzapi/tools";
 *   const log = createLogger("health");
 *   log.info("Redis connected");
 *   log.warn("Degraded:", err.message);
 *   log.error("Failed:", err);
 */

export interface Logger {
    /**
     * Log at debug level. Silent unless `PIZZAPI_DEBUG` is set to a truthy
     * value (`1`/`true`/`yes`), because in the interactive TUI anything written
     * to stdout is captured into the session transcript — per-turn diagnostics
     * printed here show up as noise in the user's chat.
     */
    debug(msg: string, ...args: unknown[]): void;
    /** Log at info level (→ stdout / console.log). */
    info(msg: string, ...args: unknown[]): void;
    /** Log at warn level (→ stderr / console.warn). */
    warn(msg: string, ...args: unknown[]): void;
    /** Log at error level (→ stderr / console.error). */
    error(msg: string, ...args: unknown[]): void;
}

/**
 * Create a tagged logger that prepends an ISO timestamp and `[tag]` to
 * every message.
 *
 * @param tag  Short component/subsystem name (e.g. "health", "sio/relay").
 */
/** Whether `PIZZAPI_DEBUG` opts this process in to debug-level output. */
function debugEnabled(): boolean {
    const flag = process.env.PIZZAPI_DEBUG;
    if (!flag) return false;
    const normalized = flag.toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function createLogger(tag: string): Logger {
    const prefix = `[${tag}]`;
    return {
        // Read the env var per call, not once at module load: the logger is
        // created at import time, long before a session decides it wants debug.
        debug: (msg, ...args) => {
            if (debugEnabled()) console.log(new Date().toISOString(), prefix, msg, ...args);
        },
        info:  (msg, ...args) => console.log(new Date().toISOString(), prefix, msg, ...args),
        warn:  (msg, ...args) => console.warn(new Date().toISOString(), prefix, msg, ...args),
        error: (msg, ...args) => console.error(new Date().toISOString(), prefix, msg, ...args),
    };
}
