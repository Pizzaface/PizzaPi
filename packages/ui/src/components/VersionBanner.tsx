import * as React from "react";
import { X } from "lucide-react";

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

    const toneClasses = protocolCompatible
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
        : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20";

    return (
        <div
            role="alert"
            className={`flex items-center justify-between gap-3 px-4 py-2 text-sm border-b ${toneClasses}`}
        >
            <span>
                <span aria-hidden="true">⚠️</span> {message}
            </span>
            <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setDismissed(true)}
                className="shrink-0 rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
            >
                <X className="size-4" />
            </button>
        </div>
    );
}
