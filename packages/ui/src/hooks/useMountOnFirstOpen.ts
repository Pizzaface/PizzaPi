import * as React from "react";

/**
 * Tracks whether a surface should be mounted. Returns `false` until the
 * `open` prop first becomes `true`, then stays `true` afterward.
 *
 * This lets lazy-loaded dialogs/panels defer their React.lazy chunk request
 * until first open while remaining mounted after close, so Radix focus
 * restoration still runs its full lifecycle.
 */
export function useMountOnFirstOpen(open: boolean): boolean {
  const [mounted, setMounted] = React.useState(open);
  React.useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return mounted;
}
