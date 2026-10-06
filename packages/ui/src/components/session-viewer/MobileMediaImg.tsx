import * as React from "react";

import { getMobileRuntimeConfig, resolveMobileMediaUrlAsync } from "@/lib/mobile-runtime";

type MediaState =
  | { kind: "loading" }
  | { kind: "ready"; src: string }
  | { kind: "error"; message: string };

/**
 * Image whose attachment URL is resolved for the bundled mobile app by minting
 * a short-lived, attachment-scoped token. On web the path is used unchanged.
 * If authorization fails, shows an error with a retry button rather than
 * falling back to a URL that carries a durable credential.
 */
export function MobileMediaImg({
  url,
  alt,
  className,
  loading,
}: {
  url: string;
  alt: string;
  className?: string;
  loading?: "lazy" | "eager";
}) {
  const { isMobileBundled } = getMobileRuntimeConfig();
  const [state, setState] = React.useState<MediaState>(
    isMobileBundled ? { kind: "loading" } : { kind: "ready", src: url },
  );
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!isMobileBundled) {
      setState({ kind: "ready", src: url });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    resolveMobileMediaUrlAsync(url).then(
      (src) => { if (!cancelled) setState({ kind: "ready", src }); },
      (err: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : "Could not load attachment" });
      },
    );
    return () => { cancelled = true; };
  }, [url, attempt, isMobileBundled]);

  if (state.kind === "ready") {
    return <img src={state.src} alt={alt} className={className} loading={loading} />;
  }
  if (state.kind === "error") {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span>{alt}: {state.message}</span>
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 text-foreground hover:bg-muted"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <div aria-busy="true" aria-label={`Loading ${alt}`} className="h-24 w-40 animate-pulse rounded border border-border bg-muted/40" />
  );
}
