import * as React from "react";
import { Loader2 } from "lucide-react";

/**
 * Loading indicator for runner settings panels. After `slowAfterMs` it appends
 * a hint that the runner may be slow — so a long wait (settings fetches can
 * take many seconds, or time out) isn't a bare, silent spinner.
 */
export function PanelLoading({
  label,
  slowAfterMs = 3000,
}: {
  label: string;
  slowAfterMs?: number;
}) {
  const [slow, setSlow] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => setSlow(true), slowAfterMs);
    return () => clearTimeout(t);
  }, [slowAfterMs]);

  return (
    <div className="flex flex-col items-center justify-center gap-1 p-8 text-center">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>{label}</span>
      </div>
      {slow && (
        <p className="text-xs text-muted-foreground/70">
          Taking longer than usual — the runner may be slow to respond.
        </p>
      )}
    </div>
  );
}
