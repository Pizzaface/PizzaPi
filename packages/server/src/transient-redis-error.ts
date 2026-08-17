/**
 * node-redis transient connection errors carry NO ErrnoException `code` —
 * they are plain Error subclasses identified only by name/message. The client
 * auto-reconnects on its own, so these must never be classified as fatal by
 * the process-level error handlers in index.ts: shutting the relay down over
 * a Redis blip disconnects every viewer and runner for something Redis
 * recovers from by itself. Seen live: SocketClosedUnexpectedlyError during a
 * Redis container restart fataled the whole server.
 */
export function isTransientRedisError(err: Error): boolean {
    return (
        err.name === "SocketClosedUnexpectedlyError" ||
        err.name === "ConnectionTimeoutError" ||
        err.name === "ClientClosedError" ||
        err.name === "ClientOfflineError" ||
        // reconnect-strategy aborts surface as generic errors with these messages
        err.message === "Socket closed unexpectedly" ||
        err.message === "Connection timeout"
    );
}
