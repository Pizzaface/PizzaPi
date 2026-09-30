import * as React from "react";
import { subscribeToast, installGlobalErrorCapture } from "@/lib/frontend-log";
import type { Toast } from "./types";

const TOAST_DISMISS_MS = 5000;

/**
 * Toast stack for ctx.ui.notify() relay events and the frontend-log toast bus.
 * Toasts auto-dismiss after 5s. Also installs the global error capture so
 * uncaught errors / unhandled rejections land in the viewable log.
 */
export function useToasts() {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  /** Show a toast; auto-dismissed after 5 seconds. Stable identity. */
  const pushToast = React.useCallback((message: string, type: Toast["type"]) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_DISMISS_MS);
  }, []);

  const dismissToast = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Bridge the frontend-log toast bus into the existing toast UI, and capture
  // uncaught errors / unhandled rejections so they land in the viewable log.
  React.useEffect(() => {
    installGlobalErrorCapture();
    return subscribeToast(({ message, type }) => pushToast(message, type));
  }, [pushToast]);

  return { toasts, pushToast, dismissToast };
}
