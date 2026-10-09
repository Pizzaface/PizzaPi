/** Hash an API key the same way better-auth stores apikey.key. */
export async function hashApiKey(rawKey: string): Promise<string> {
    const keyHashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
    return btoa(String.fromCharCode(...new Uint8Array(keyHashBuf)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
}
