import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Toast } from "../types";

/**
 * PATCH(pizzapi): Toast notifications for ctx.ui.notify().
 *
 * Live region so screen readers announce toasts (WCAG 4.1.3). The container
 * is always mounted so dynamically-added toasts are read; error toasts use
 * role=alert (assertive), others role=status.
 */
export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.type === "error" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto max-w-sm rounded-lg border p-4 shadow-lg backdrop-blur-sm animate-in slide-in-from-bottom-2 fade-in duration-200",
            toast.type === "error"
              ? "bg-red-950/80 border-red-800 text-red-200"
              : toast.type === "warning"
                ? "bg-yellow-950/80 border-yellow-800 text-yellow-200"
                : "bg-zinc-900/90 border-zinc-800 text-zinc-200",
          )}
        >
          <div className="flex items-start gap-3">
            <div className="flex-1 text-sm font-medium">{toast.message}</div>
            <button
              onClick={() => onDismiss(toast.id)}
              className="shrink-0 rounded-md p-1 hover:bg-white/10 text-inherit transition-colors"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
