import * as React from "react";
import { resetStaleBaselineOnVisibilityChange } from "@/lib/viewer-connection";
import { getStaleThresholdMs } from "./constants";
import type { ViewerRefs } from "./useViewerRefs";

/**
 * Tab-visibility driven connection liveness:
 * - resets the stale-event baseline when visibility changes and widens the
 *   stale threshold while hidden (browser timer throttling);
 * - kicks the viewer and hub sockets to reconnect immediately when the tab
 *   foregrounds or the network returns (bypassing socket.io's backoff).
 *
 * Returns an always-current ref to the stale threshold for the watchdog.
 */
export function useViewerLiveness(refs: ViewerRefs) {
  const { lastViewerEventAtRef, viewerWsRef, hubSocketRef } = refs;
  const [isPageHidden, setIsPageHidden] = React.useState(() => document.visibilityState === "hidden");
  const staleThresholdMs = getStaleThresholdMs(isPageHidden);
  const staleThresholdMsRef = React.useRef(staleThresholdMs);
  staleThresholdMsRef.current = staleThresholdMs;

  React.useEffect(() => {
    const handleVisibilityChange = () => {
      lastViewerEventAtRef.current = resetStaleBaselineOnVisibilityChange(
        document.visibilityState,
        lastViewerEventAtRef.current,
        Date.now(),
      );
      setIsPageHidden(document.visibilityState === "hidden");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconnect immediately when the tab foregrounds or the network returns.
  // socket.io's reconnect backoff can sit up to ~30s after a background
  // suspension; a manual connect() bypasses the backoff timer entirely and
  // is a no-op when already connected/connecting.
  React.useEffect(() => {
    const kickSockets = () => {
      if (document.visibilityState !== "visible") return;
      const viewer = viewerWsRef.current;
      if (viewer && !viewer.connected) viewer.connect();
      const hub = hubSocketRef.current;
      if (hub && !hub.connected) hub.connect();
    };
    window.addEventListener("online", kickSockets);
    document.addEventListener("visibilitychange", kickSockets);
    return () => {
      window.removeEventListener("online", kickSockets);
      document.removeEventListener("visibilitychange", kickSockets);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return staleThresholdMsRef;
}
