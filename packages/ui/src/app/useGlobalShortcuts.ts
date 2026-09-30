import * as React from "react";
import type { SessionLifecycleRefs } from "@/lib/use-session-lifecycle";
import { makeExecId } from "./constants";
import { isTextEntryTarget, resolveGlobalShortcut } from "./global-shortcuts";
import type { StateSetter } from "./types";

export interface GlobalShortcutsOptions {
  isMac: boolean;
  agentActive: boolean;
  lifecycleRefs: SessionLifecycleRefs;
  promptRef: React.RefObject<HTMLTextAreaElement | null>;
  sendRemoteExec: (payload: any) => boolean;
  setShowShortcutsHelp: StateSetter<boolean>;
  setShowTerminal: StateSetter<boolean>;
  setShowFileExplorer: StateSetter<boolean>;
  setHistoryOpen: StateSetter<boolean>;
}

/** Window-level keyboard shortcuts (see `resolveGlobalShortcut` for the map). */
export function useGlobalShortcuts(options: GlobalShortcutsOptions) {
  const {
    isMac,
    agentActive,
    lifecycleRefs,
    promptRef,
    sendRemoteExec,
    setShowShortcutsHelp,
    setShowTerminal,
    setShowFileExplorer,
    setHistoryOpen,
  } = options;

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = resolveGlobalShortcut(
        e,
        isMac,
        isTextEntryTarget(e.target as HTMLElement),
        () => !!document.querySelector('[role="dialog"]'),
      );
      if (!action) return;
      // Every shortcut except `?` suppresses the browser default.
      if (action !== "show-shortcuts") e.preventDefault();
      switch (action) {
        case "show-shortcuts":
          setShowShortcutsHelp(true);
          return;
        case "focus-prompt":
          promptRef.current?.focus();
          return;
        case "toggle-terminal":
          setShowTerminal((v) => !v);
          return;
        case "toggle-file-explorer":
          setShowFileExplorer((v) => !v);
          return;
        case "toggle-history":
          setHistoryOpen((v) => !v);
          return;
        case "abort":
          if (agentActive && lifecycleRefs.activeSessionId.current) {
            sendRemoteExec({
              type: "exec",
              id: makeExecId(),
              command: "abort",
            });
          }
          return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMac, agentActive, sendRemoteExec]);
}
