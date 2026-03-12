import * as React from "react";
import { ShieldIcon } from "lucide-react";

export function TogglePlanModeCard({ enabled }: { enabled: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs text-zinc-400">
      <ShieldIcon className="size-3.5 shrink-0 text-blue-400" />
      <span>
        {enabled ? (
          <span className="font-medium text-blue-300">Plan Mode Activated</span>
        ) : (
          <span className="font-medium text-zinc-300">Plan Mode Deactivated</span>
        )}
      </span>
    </div>
  );
}
