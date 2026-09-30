import * as React from "react";

/**
 * Open a session when asked from outside React: service-worker messages
 * (push notification click → `{ type: "open-session", sessionId }`) and the
 * `pp-navigate-session` window event fired by browser notification clicks.
 */
export function useSessionNavigationListeners(handleOpenSession: (id: string) => void) {
  // Listen for messages from the service worker (e.g. notification click → open session)
  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "open-session" && typeof event.data.sessionId === "string") {
        handleOpenSession(event.data.sessionId);
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, [handleOpenSession]);

  // Listen for browser notification clicks to navigate to the session.
  React.useEffect(() => {
    const handler = (e: Event) => {
      const sessionId = (e as CustomEvent).detail?.sessionId;
      if (typeof sessionId === "string") handleOpenSession(sessionId);
    };
    window.addEventListener("pp-navigate-session", handler);
    return () => window.removeEventListener("pp-navigate-session", handler);
  }, [handleOpenSession]);
}
