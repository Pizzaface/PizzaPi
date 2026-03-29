import * as React from "react";
import type { Entry as AtMentionEntry } from "@/hooks/useAtMentionFiles";

export interface AtMentionState {
  atMentionOpen: boolean;
  setAtMentionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  atMentionPath: string;
  setAtMentionPath: React.Dispatch<React.SetStateAction<string>>;
  atMentionQuery: string;
  setAtMentionQuery: React.Dispatch<React.SetStateAction<string>>;
  atMentionTriggerOffset: number;
  setAtMentionTriggerOffset: React.Dispatch<React.SetStateAction<number>>;
  atMentionHighlightedIndex: number;
  setAtMentionHighlightedIndex: React.Dispatch<React.SetStateAction<number>>;
  atMentionHighlightedEntry: AtMentionEntry | null;
  setAtMentionHighlightedEntry: React.Dispatch<React.SetStateAction<AtMentionEntry | null>>;
  atMentionHighlightedAgent: string | null;
  setAtMentionHighlightedAgent: React.Dispatch<React.SetStateAction<string | null>>;
  atMentionAgents: Array<{ name: string; description?: string }>;
  setAtMentionAgents: React.Dispatch<React.SetStateAction<Array<{ name: string; description?: string }>>>;
  /** Stable ref tracking which runnerId agents were last fetched for. */
  atMentionAgentsFetchedForRef: React.MutableRefObject<string | null>;
}

export interface AtMentionHandlers {
  handleAtMentionSelectFile: (relativePath: string) => void;
  handleAtMentionDrillInto: (newPath: string) => void;
  handleAtMentionBack: () => void;
  handleAtMentionClose: () => void;
  handleAtMentionSelectAgent: (agentName: string) => void;
}

export interface AtMentionResult extends AtMentionState, AtMentionHandlers {}

/**
 * Owns all @-mention popover state and the action handlers for file/agent selection,
 * directory drill-in, back navigation, and popover close.
 *
 * Also fetches the agent list for the connected runner (fast path via runnerInfo,
 * with a REST fallback) when the popover opens.
 */
export function useAtMentionHandlers(
  inputRef: React.MutableRefObject<string>,
  setInput: (value: string) => void,
  runnerId: string | undefined,
  runnerInfo: import("@pizzapi/protocol").RunnerInfo | null | undefined,
): AtMentionResult {
  const [atMentionOpen, setAtMentionOpen] = React.useState(false);
  const [atMentionPath, setAtMentionPath] = React.useState("");
  const [atMentionQuery, setAtMentionQuery] = React.useState("");
  const [atMentionTriggerOffset, setAtMentionTriggerOffset] = React.useState(0);
  const [atMentionHighlightedIndex, setAtMentionHighlightedIndex] = React.useState(0);
  const [atMentionHighlightedEntry, setAtMentionHighlightedEntry] =
    React.useState<AtMentionEntry | null>(null);
  const [atMentionHighlightedAgent, setAtMentionHighlightedAgent] =
    React.useState<string | null>(null);
  const [atMentionAgents, setAtMentionAgents] = React.useState<
    Array<{ name: string; description?: string }>
  >([]);
  const atMentionAgentsFetchedForRef = React.useRef<string | null>(null);

  // Populate agents when the @-mention popover opens
  React.useEffect(() => {
    if (!atMentionOpen || !runnerId) return;
    if (runnerInfo) {
      const agents = runnerInfo.agents.map((a) => ({ name: a.name, description: a.description }));
      setAtMentionAgents(agents);
      return;
    }
    if (atMentionAgentsFetchedForRef.current === runnerId) return;
    atMentionAgentsFetchedForRef.current = runnerId;
    let stale = false;
    fetch(`/api/runners/${encodeURIComponent(runnerId)}/agents`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: unknown) => {
        if (stale) return;
        const raw = data as { agents?: Array<{ name: string; description?: string }> };
        const agents = Array.isArray(raw?.agents)
          ? raw.agents.map((a) => ({ name: a.name, description: a.description }))
          : [];
        setAtMentionAgents(agents);
      })
      .catch(() => {
        if (!stale) {
          atMentionAgentsFetchedForRef.current = null;
          setAtMentionAgents([]);
        }
      });
    return () => {
      stale = true;
    };
  }, [atMentionOpen, runnerId, runnerInfo]);

  const resetAtMentionState = React.useCallback(() => {
    setAtMentionOpen(false);
    setAtMentionQuery("");
    setAtMentionPath("");
    setAtMentionTriggerOffset(0);
    setAtMentionHighlightedIndex(0);
  }, []);

  /** Select a file entry: insert @{relativePath} into the textarea. */
  const handleAtMentionSelectFile = React.useCallback(
    (relativePath: string) => {
      const textarea = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
      if (!textarea) return;
      const cursorPosition = textarea.selectionStart;
      const value = inputRef.current;
      const newValue =
        value.slice(0, atMentionTriggerOffset) + "@" + relativePath + " " + value.slice(cursorPosition);
      setInput(newValue);
      const newCursorPosition = atMentionTriggerOffset + 1 + relativePath.length + 1;
      requestAnimationFrame(() => {
        textarea.setSelectionRange(newCursorPosition, newCursorPosition);
        textarea.focus();
      });
      resetAtMentionState();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [atMentionTriggerOffset, resetAtMentionState, setInput, inputRef],
  );

  /** Drill into a directory, updating the textarea text to reflect the new path. */
  const handleAtMentionDrillInto = React.useCallback(
    (newPath: string) => {
      setAtMentionPath(newPath);
      setAtMentionQuery("");
      setAtMentionHighlightedIndex(0);
      const textarea = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
      if (textarea) {
        const cursorPosition = textarea.selectionStart;
        const value = inputRef.current;
        const newValue =
          value.slice(0, atMentionTriggerOffset) + "@" + newPath + value.slice(cursorPosition);
        setInput(newValue);
        const newCursorPosition = atMentionTriggerOffset + 1 + newPath.length;
        requestAnimationFrame(() => {
          textarea.setSelectionRange(newCursorPosition, newCursorPosition);
          textarea.focus();
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [atMentionTriggerOffset, setInput, inputRef],
  );

  /** Navigate up one directory level. */
  const handleAtMentionBack = React.useCallback(() => {
    if (!atMentionPath) return;
    const segments = atMentionPath.split("/").filter(Boolean);
    const newPath = segments.slice(0, -1).join("/");
    const newPathWithSlash = newPath ? newPath + "/" : "";
    handleAtMentionDrillInto(newPathWithSlash);
  }, [atMentionPath, handleAtMentionDrillInto]);

  /** Close the @-mention popover and reset all related state. */
  const handleAtMentionClose = React.useCallback(() => {
    setAtMentionOpen(false);
    setAtMentionQuery("");
    setAtMentionPath("");
    setAtMentionTriggerOffset(0);
    setAtMentionHighlightedIndex(0);
    setAtMentionHighlightedEntry(null);
    setAtMentionHighlightedAgent(null);
  }, []);

  /** Select an agent entry: insert @agentName into the textarea. */
  const handleAtMentionSelectAgent = React.useCallback(
    (agentName: string) => {
      const textarea = document.querySelector<HTMLTextAreaElement>("[data-pp-prompt]");
      if (!textarea) return;
      const cursorPosition = textarea.selectionStart;
      const value = inputRef.current;
      const newValue =
        value.slice(0, atMentionTriggerOffset) + "@" + agentName + " " + value.slice(cursorPosition);
      setInput(newValue);
      const newCursorPosition = atMentionTriggerOffset + 1 + agentName.length + 1;
      requestAnimationFrame(() => {
        textarea.setSelectionRange(newCursorPosition, newCursorPosition);
        textarea.focus();
      });
      resetAtMentionState();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [atMentionTriggerOffset, resetAtMentionState, setInput, inputRef],
  );

  return {
    atMentionOpen,
    setAtMentionOpen,
    atMentionPath,
    setAtMentionPath,
    atMentionQuery,
    setAtMentionQuery,
    atMentionTriggerOffset,
    setAtMentionTriggerOffset,
    atMentionHighlightedIndex,
    setAtMentionHighlightedIndex,
    atMentionHighlightedEntry,
    setAtMentionHighlightedEntry,
    atMentionHighlightedAgent,
    setAtMentionHighlightedAgent,
    atMentionAgents,
    setAtMentionAgents,
    atMentionAgentsFetchedForRef,
    handleAtMentionSelectFile,
    handleAtMentionDrillInto,
    handleAtMentionBack,
    handleAtMentionClose,
    handleAtMentionSelectAgent,
  };
}
