/**
 * Structured logger for the PizzaPi runner subsystem.
 *
 * Every line is prefixed with an ISO timestamp so log files (which are plain
 * file redirects from launchd) become correlatable.  An optional session ID
 * tag lets us trace interleaved output from the daemon, supervisor, and
 * multiple concurrent worker processes back to individual sessions.
 *
 * Format:
 *   2026-03-19T22:31:20.123Z [component] message
 *   2026-03-19T22:31:20.123Z [component:a1b2c3d4] message   (with session)
 *
 * The short session ID (first 8 chars) keeps lines readable while still
 * being unique enough to grep for.
 */

type LogLevel = "info" | "warn" | "error";

const WRITERS: Record<LogLevel, (msg: string) => void> = {
    info:  (msg) => process.stdout.write(msg + "\n"),
    warn:  (msg) => process.stderr.write(msg + "\n"),
    error: (msg) => process.stderr.write(msg + "\n"),
};

let _component: string = "unknown";
let _sessionId: string | null = null;

/** Set the component name (call once at process start). */
export function setLogComponent(component: "supervisor" | "daemon" | "worker" | "cc-bridge"): void {
    _component = component;
}

/** Set the session ID for this process (workers only). */
export function setLogSessionId(sessionId: string | null): void {
    _sessionId = sessionId;
}

function formatTag(sessionOverride?: string | null): string {
    const sid = sessionOverride !== undefined ? sessionOverride : _sessionId;
    if (sid) {
        return `[${_component}:${sid.slice(0, 8)}]`;
    }
    return `[${_component}]`;
}

function formatLine(level: LogLevel, msg: string, sessionOverride?: string | null): string {
    const ts = new Date().toISOString();
    const tag = formatTag(sessionOverride);
    const prefix = `${ts} ${tag} `;
    // Prefix every line so multiline messages (e.g. stack traces) stay
    // correlatable when interleaved with output from other workers.
    return msg
        .split("\n")
        .map((line) => `${prefix}${line}`)
        .join("\n");
}

/** Log at info level (→ stdout → runner.log). */
export function logInfo(msg: string, sessionId?: string | null): void {
    WRITERS.info(formatLine("info", msg, sessionId));
}

/** Log at warn level (→ stderr → runner-error.log). */
export function logWarn(msg: string, sessionId?: string | null): void {
    WRITERS.warn(formatLine("warn", msg, sessionId));
}

/** Log at error level (→ stderr → runner-error.log). */
export function logError(msg: string, sessionId?: string | null): void {
    WRITERS.error(formatLine("error", msg, sessionId));
}

/**
 * Log an auth diagnostic event.  These go to stdout (runner.log) so they're
 * available alongside normal operational logs for correlation.
 */
export function logAuth(event: string, details: Record<string, unknown>, sessionId?: string | null): void {
    const detailStr = Object.entries(details)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
    WRITERS.info(formatLine("info", `[auth] ${event}: ${detailStr}`, sessionId));
}
