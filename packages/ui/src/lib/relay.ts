export function getRelayWsBase(): string {
    const configured = import.meta.env?.VITE_RELAY_URL?.trim();
    const fallback = window.location.origin.replace(/^http/, "ws");
    const value = configured && configured.length > 0 ? configured : fallback;
    const normalized = value.replace(/\/$/, "");

    if (normalized.startsWith("ws://") || normalized.startsWith("wss://")) {
        return normalized;
    }
    if (normalized.startsWith("http://")) {
        return `ws://${normalized.slice("http://".length)}`;
    }
    if (normalized.startsWith("https://")) {
        return `wss://${normalized.slice("https://".length)}`;
    }

    return normalized;
}

/**
 * Return the base URL for the Socket.IO server.
 *
 * Socket.IO runs on the same port as the REST API, so in all environments
 * (dev via Vite proxy, production) we simply return the current origin (or
 * an empty string — socket.io-client treats that as "same origin").
 *
 * Can be overridden with the `VITE_SOCKETIO_URL` env var if needed.
 */
export function getSocketIOBase(): string {
    // Explicit override
    const configured = import.meta.env?.VITE_SOCKETIO_URL?.trim();
    if (configured && configured.length > 0) return configured.replace(/\/$/, "");

    // Default: same origin (Socket.IO is on the same port as the REST API)
    return "";
}
