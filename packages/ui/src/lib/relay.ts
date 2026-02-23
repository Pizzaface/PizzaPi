export function getRelayWsBase(): string {
    const configured = ((import.meta as any).env?.VITE_RELAY_URL as string | undefined)?.trim();
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
 * In dev the Vite proxy forwards `/socket.io/` to the Socket.IO port, so we
 * can simply return the current origin (or an empty string — socket.io-client
 * treats that as "same origin").
 *
 * In production the Socket.IO server runs on PORT+1 unless overridden by the
 * `VITE_SOCKETIO_URL` env var.
 */
export function getSocketIOBase(): string {
    // Explicit override
    const configured = ((import.meta as any).env?.VITE_SOCKETIO_URL as string | undefined)?.trim();
    if (configured && configured.length > 0) return configured.replace(/\/$/, "");

    // Default: same origin but on PORT+1
    const origin = window.location.origin;
    const url = new URL(origin);
    const port = parseInt(url.port || (url.protocol === "https:" ? "443" : "80"));
    url.port = String(port + 1);
    return url.origin;
}
