import * as React from "react";
import { TagIcon } from "lucide-react";

export function SessionNameCard({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-2.5 text-xs text-zinc-400">
      <TagIcon className="size-3.5 shrink-0 text-zinc-500" />
      <span>
        Session named <span className="font-medium text-zinc-200">{name}</span>
      </span>
    </div>
  );
}
