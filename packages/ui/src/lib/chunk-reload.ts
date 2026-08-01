/**
 * A lazy chunk import fails ("Failed to fetch dynamically imported module")
 * when the server has been redeployed and this tab's index.html still points at
 * chunk hashes that no longer exist. Reload to pick up the new build.
 *
 * Vite dispatches `vite:preloadError` for every failed dynamic import, so one
 * listener covers all React.lazy call sites.
 *
 * ponytail: reload, no retry/backoff. The sessionStorage timestamp is the loop
 * guard — if the chunk is still missing after a reload (or storage is blocked)
 * the error surfaces to the error boundary as before.
 */
const KEY = "pizzapi:chunk-reload";
const COOLDOWN_MS = 30_000;

/** Exported for tests. Returns true if the caller should reload. */
export function shouldReloadOnChunkError(storage: Pick<Storage, "getItem" | "setItem">, now: number): boolean {
    try {
        const last = Number(storage.getItem(KEY) ?? 0);
        if (now - last < COOLDOWN_MS) return false;
        storage.setItem(KEY, String(now));
        return true;
    } catch {
        // No storage means no loop guard, so don't reload.
        return false;
    }
}

export function installChunkReloadHandler(): void {
    window.addEventListener("vite:preloadError", (event) => {
        if (!shouldReloadOnChunkError(window.sessionStorage, Date.now())) return;
        event.preventDefault(); // suppress the rethrow so no error UI flashes before reload
        window.location.reload();
    });
}
