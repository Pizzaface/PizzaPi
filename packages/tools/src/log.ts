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
export function createLogger(tag: string): Logger {
    const prefix = `[${tag}]`;
    return {
        info:  (msg, ...args) => console.log(new Date().toISOString(), prefix, msg, ...args),
        warn:  (msg, ...args) => console.warn(new Date().toISOString(), prefix, msg, ...args),
        error: (msg, ...args) => console.error(new Date().toISOString(), prefix, msg, ...args),
    };
}
