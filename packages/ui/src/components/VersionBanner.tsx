import * as React from "react";
import { X } from "lucide-react";

/**
 * Clear all Cache Storage entries and any active service worker,
 * then do a hard reload so fresh assets are fetched from the network.
 */
async function clearCacheAndReload() {
    if ("caches" in window) {
        for (const name of await caches.keys()) await caches.delete(name);
    }
    if ("serviceWorker" in navigator) {
        for (const reg of await navigator.serviceWorker.getRegistrations()) {
            await reg.unregister();
        }
    }
    location.reload();
}

export function VersionBanner({
    message,
    protocolCompatible,
}: {
    message: string | null;
    protocolCompatible: boolean;
}) {
    const [dismissed, setDismissed] = React.useState(false);

    React.useEffect(() => {
        setDismissed(false);
    }, [message, protocolCompatible]);

    if (!message || dismissed) return null;

    const lc = message.toLowerCase();
    const isUpdate = lc.includes("newer") || lc.includes("deployed");
    const toneClasses = protocolCompatible
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
        : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20";

    return (
        <div
            role="alert"
            className={`flex items-center justify-between gap-3 px-4 py-2 text-sm border-b ${toneClasses}`}
        >
            <span className="flex items-center gap-2">
                <span aria-hidden="true">⚠️</span> {message}
            </span>
            <div className="flex items-center gap-1 shrink-0">
                {isUpdate && (
                    <button
                        type="button"
                        onClick={clearCacheAndReload}
                        className="rounded px-2 py-1 font-medium hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                    >
                        Update &amp; Reload
                    </button>
                )}
                <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => setDismissed(true)}
                    className="rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                >
                    <X className="size-4" />
                </button>
            </div>
        </div>
    );
}
