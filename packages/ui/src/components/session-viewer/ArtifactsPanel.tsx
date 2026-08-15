import * as React from "react";

import { cn } from "@/lib/utils";
import { ArtifactCard } from "@/components/session-viewer/ArtifactCard";
import { useSessionArtifacts } from "@/components/session-viewer/use-session-artifacts";
import type { RelayMessage } from "@/components/session-viewer/types";
import type { ResolvedModeUi } from "@pizzapi/protocol";

interface ArtifactsPanelProps {
  /** Session messages to scan for deliverables. */
  messages: RelayMessage[];
  /** Resolved mode UI controlling artifact detection. */
  modeUi: ResolvedModeUi | null | undefined;
  /** Runner that owns the files. */
  runnerId?: string;
  /** Open a path in the file explorer, when the host supports it. */
  onOpenArtifact?: (path: string) => void;
}

/**
 * A browsable list of all deliverables produced in the session.
 *
 * Artifacts already render inline in the transcript; this panel gives users a
 * dedicated place to find them without scrolling back through the chat.
 *
 * ponytail: reuses ArtifactCard for preview/download so the panel gets the
 * same rendering as inline artifacts with no duplicated fetch logic.
 */
export function ArtifactsPanel({ messages, modeUi, runnerId, onOpenArtifact }: ArtifactsPanelProps) {
  const artifacts = useSessionArtifacts(messages, modeUi);
  if (artifacts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 text-center text-sm text-muted-foreground">
        <p>No artifacts yet.</p>
        <p className="mt-1 max-w-[16rem]">
          Deliverables produced by this session will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
        {artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}
      </div>
      <div className="flex-1 overflow-auto">
        {artifacts.map((artifact) => (
          <div
            key={artifact.path}
            className={cn(
              "border-b border-border p-2",
              "hover:bg-accent/50 transition-colors",
            )}
          >
            <ArtifactCard
              path={artifact.path}
              kind={artifact.kind}
              runnerId={runnerId}
              onOpen={onOpenArtifact}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
