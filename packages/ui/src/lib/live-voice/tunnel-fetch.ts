/** Retry a cross-origin tunnel fetch through its signed relay-path URL on network/CORS failure. */
export async function fetchTunnelWithFallback(
    primary: URL,
    fallback: URL | null,
    init?: RequestInit,
    fetcher: (url: URL, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
    try {
        return await fetcher(primary, init);
    } catch (error) {
        if (!fallback || fallback.href === primary.href) throw error;
        return fetcher(fallback, init);
    }
}
