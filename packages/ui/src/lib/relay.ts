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
