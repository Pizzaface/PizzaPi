import * as React from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Inline error message bar used in dialogs and forms.
 *
 * Replaces the repeated pattern:
 * ```
 * <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">
 *   <AlertCircle className="..." />
 *   {error}
 * </div>
 * ```
 */
export function ErrorAlert({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md",
        className,
      )}
    >
      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
      {children}
    </div>
  );
}
