import * as React from "react";
import type { CmdEntry } from "./viewer-types";
import type { CommandResultData } from "./rendering";
import type { SandboxViolationEntry } from "./cards/CommandResultCard";
import type { ResumeSessionOption } from "@/lib/types";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import {
  type IncompleteTriggerItem,
  type TriggerHistoryEntry,
  getIncompleteTriggers,
} from "@/components/TriggersPanel";

export interface SupportedSubCommand {
  name: string;
  description: string;
  requiresArg?: boolean;
}

export interface SupportedCommand {
  name: string;
  description: string;
  subCommands?: SupportedSubCommand[];
}

export interface SubCommandMode {
  active: boolean;
  parentCommand: string;
  subCommands: SupportedSubCommand[];
  query: string;
  filtered: SupportedSubCommand[];
}

export interface SlashCommandDeps {
  sessionId: string | null;
  sessionIdRef: React.MutableRefObject<string | null>;
  compactingRef: React.MutableRefObject<boolean>;
  onExec?: (payload: unknown) => boolean | void;
  onSendInput?: (
    message: (PromptInputMessage & { deliverAs?: "steer" | "followUp" }) | string,
  ) => boolean | void | Promise<boolean | void>;
  resumeSessions?: ResumeSessionOption[];
  onRequestResumeSessions?: () => boolean | void;
  runnerId?: string;
  sessionCwd?: string;
  onAppendSystemMessage?: (content: string | CommandResultData) => void;
  onShowModelSelector?: () => void;
  isCompacting?: boolean;
  onSpawnAgentSession?: (agent: {
    name: string;
    description?: string;
    systemPrompt?: string;
  }) => void;
  runnerInfo?: import("@pizzapi/protocol").RunnerInfo | null;
  skillCommands: CmdEntry[];
  extensionCommands: CmdEntry[];
  promptCommands: CmdEntry[];
  /**
   * Called when /new or /resume detects active linked sessions that would be
   * disconnected. The caller is responsible for showing a confirmation dialog
   * and invoking `action()` if the user confirms.
   */
  onIncompleteTriggers: (incomplete: IncompleteTriggerItem[], action: () => void) => void;
}

export interface SlashCommandState {
  commandOpen: boolean;
  setCommandOpen: React.Dispatch<React.SetStateAction<boolean>>;
  commandQuery: string;
  setCommandQuery: React.Dispatch<React.SetStateAction<string>>;
  commandHighlightedIndex: number;
  setCommandHighlightedIndex: React.Dispatch<React.SetStateAction<number>>;
  executeSlashCommand: (text: string) => boolean;
  supportedWebCommands: SupportedCommand[];
  knownCommandNames: Set<string>;
  keepPopoverOpenNames: Set<string>;
  commandSuggestions: SupportedCommand[];
  skillSuggestions: CmdEntry[];
  extensionSuggestions: CmdEntry[];
  promptSuggestions: CmdEntry[];
  isResumeMode: boolean;
  isAgentMode: boolean;
  resumeQuery: string;
  resumeCandidates: ResumeSessionOption[];
  /** Check for incomplete triggers, then run action (or invoke onIncompleteTriggers). */
  checkTriggersAndRun: (action: () => void) => Promise<void>;
  requestNewSession: () => void;
  resumeRequestedRef: React.MutableRefObject<string | null>;
  subCommandMode: SubCommandMode;
  trimmedInput: string;
}

/**
 * Manages all slash-command state: the command picker (open/close/query/highlight),
 * suggestion filtering, and the executeSlashCommand callback that dispatches each
 * command to the runner via onExec / onSendInput.
 *
 * Also owns `checkTriggersAndRun` (guards /new and /resume against incomplete
 * linked sessions) and `requestNewSession`.
 */
export function useSlashCommands(
  input: string,
  setInput: (v: string) => void,
  deps: SlashCommandDeps,
): SlashCommandState {
  const {
    sessionId,
    sessionIdRef,
    compactingRef,
    onExec,
    onSendInput,
    resumeSessions,
    onRequestResumeSessions,
    runnerId,
    sessionCwd,
    onAppendSystemMessage,
    onShowModelSelector,
    isCompacting,
    onSpawnAgentSession,
    runnerInfo,
    skillCommands,
    extensionCommands,
    promptCommands,
    onIncompleteTriggers,
  } = deps;

  const [commandOpen, setCommandOpen] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState("");
  const [commandHighlightedIndex, setCommandHighlightedIndex] = React.useState(0);
  const resumeRequestedRef = React.useRef<string | null>(null);

  // Commands natively handled by the web UI (excluded from CLI "extension commands" group).
  const webHandledCommands = React.useMemo(
    () =>
      new Set([
        "new", "resume", "mcp", "plugins", "skills", "agents", "model",
        "cycle_model", "effort", "cycle_effort", "compact", "name", "copy",
        "stop", "restart", "remote", "plan", "sandbox",
      ]),
    [],
  );
  void webHandledCommands; // used externally; keep reference alive

  const supportedWebCommands = React.useMemo<SupportedCommand[]>(
    () => [
      { name: "new", description: "Start a new conversation" },
      { name: "resume", description: "Resume the previous session" },
      {
        name: "mcp",
        description: "MCP server management",
        subCommands: [
          { name: "status", description: "Show MCP server status" },
          { name: "reload", description: "Reload MCP servers" },
          { name: "disable", description: "Disable an MCP server", requiresArg: true },
          { name: "enable", description: "Enable a disabled MCP server", requiresArg: true },
        ],
      },
      { name: "plugins", description: "Show loaded plugins" },
      { name: "skills", description: "Show available skills" },
      { name: "agents", description: "Start a new session as an agent" },
      { name: "model", description: "Select model" },
      { name: "cycle_model", description: "Select model" },
      { name: "effort", description: "Cycle reasoning effort level" },
      { name: "cycle_effort", description: "Cycle reasoning effort level" },
      { name: "compact", description: "Compact context" },
      { name: "name", description: "Set session name" },
      { name: "copy", description: "Copy last assistant message" },
      { name: "stop", description: "Abort current generation" },
      { name: "restart", description: "Restart the CLI process" },
      { name: "plan", description: "Toggle plan mode (read-only exploration)" },
      { name: "sandbox", description: "Show sandbox status" },
    ],
    [],
  );

  const knownCommandNames = React.useMemo(() => {
    const names = new Set<string>();
    for (const c of supportedWebCommands) names.add(c.name.toLowerCase());
    for (const c of extensionCommands) names.add(c.name.toLowerCase());
    for (const c of skillCommands) names.add(c.name.toLowerCase());
    for (const c of promptCommands) names.add(c.name.toLowerCase());
    return names;
  }, [supportedWebCommands, extensionCommands, skillCommands, promptCommands]);

  const keepPopoverOpenNames = React.useMemo(() => {
    const names = new Set(["resume", "agents"]);
    for (const c of supportedWebCommands) {
      if (c.subCommands && c.subCommands.length > 0) names.add(c.name.toLowerCase());
    }
    return names;
  }, [supportedWebCommands]);

  // Reset all command picker state when the active session changes
  React.useEffect(() => {
    setCommandOpen(false);
    setCommandQuery("");
    setCommandHighlightedIndex(0);
  }, [sessionId]);

  // Reset highlighted index when the query changes
  React.useEffect(() => {
    setCommandHighlightedIndex(0);
  }, [commandQuery]);

  const commandSuggestions = React.useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) return supportedWebCommands;
    return supportedWebCommands.filter((c) => c.name.toLowerCase().includes(query));
  }, [commandQuery, supportedWebCommands]);

  const skillSuggestions = React.useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) return skillCommands;
    return skillCommands.filter(
      (c) =>
        c.name.toLowerCase().includes(query) ||
        (c.description?.toLowerCase().includes(query) ?? false),
    );
  }, [commandQuery, skillCommands]);

  const extensionSuggestions = React.useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) return extensionCommands;
    return extensionCommands.filter(
      (c) =>
        c.name.toLowerCase().includes(query) ||
        (c.description?.toLowerCase().includes(query) ?? false),
    );
  }, [commandQuery, extensionCommands]);

  const promptSuggestions = React.useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) return promptCommands;
    return promptCommands.filter(
      (c) =>
        c.name.toLowerCase().includes(query) ||
        (c.description?.toLowerCase().includes(query) ?? false),
    );
  }, [commandQuery, promptCommands]);

  const trimmedInput = input.trimStart();
  const isResumeMode = /^\/resume(?:\s|$)/i.test(trimmedInput);
  const isAgentMode = /^\/agents(?:\s|$)/i.test(trimmedInput);
  const resumeQuery = isResumeMode
    ? trimmedInput.replace(/^\/resume\s*/i, "").trim().toLowerCase()
    : "";

  const resumeCandidates = React.useMemo(() => {
    const list = resumeSessions ?? [];
    if (!resumeQuery) return list;
    return list.filter((session) => {
      const name = (session.name ?? "").toLowerCase();
      const id = session.id.toLowerCase();
      const path = session.path.toLowerCase();
      const preview = (session.firstMessage ?? "").toLowerCase();
      return (
        name.includes(resumeQuery) ||
        id.includes(resumeQuery) ||
        path.includes(resumeQuery) ||
        preview.includes(resumeQuery)
      );
    });
  }, [resumeSessions, resumeQuery]);

  // Sub-command mode (e.g. "/mcp " shows mcp sub-commands)
  const subCommandMode = React.useMemo<SubCommandMode>(() => {
    if (isResumeMode || isAgentMode)
      return { active: false, parentCommand: "", subCommands: [], query: "", filtered: [] };
    const match = trimmedInput.match(/^\/(\S+)(?:\s(.*))?$/i);
    if (!match)
      return { active: false, parentCommand: "", subCommands: [], query: "", filtered: [] };
    const cmdName = match[1]!.toLowerCase();
    const argText = (match[2] ?? "").trim().toLowerCase();
    const cmd = supportedWebCommands.find(
      (c) => c.name.toLowerCase() === cmdName && c.subCommands && c.subCommands.length > 0,
    );
    if (!cmd?.subCommands)
      return { active: false, parentCommand: "", subCommands: [], query: "", filtered: [] };
    const filtered = argText
      ? cmd.subCommands.filter((sc) => sc.name.toLowerCase().includes(argText))
      : cmd.subCommands;
    return {
      active: true,
      parentCommand: cmd.name,
      subCommands: cmd.subCommands,
      query: argText,
      filtered,
    };
  }, [trimmedInput, isResumeMode, isAgentMode, supportedWebCommands]);

  // Request resume sessions list when entering resume mode
  React.useEffect(() => {
    if (!sessionId || !commandOpen || !isResumeMode || !onRequestResumeSessions) return;
    const requestKey = sessionId;
    if (resumeRequestedRef.current === requestKey) return;
    resumeRequestedRef.current = requestKey;
    onRequestResumeSessions();
  }, [sessionId, commandOpen, isResumeMode, onRequestResumeSessions]);

  React.useEffect(() => {
    if (!sessionId) resumeRequestedRef.current = null;
  }, [sessionId]);

  React.useEffect(() => {
    if (!commandOpen || !isResumeMode) resumeRequestedRef.current = null;
  }, [commandOpen, isResumeMode]);

  /** Check for incomplete triggers, then run the action or invoke onIncompleteTriggers. */
  const checkTriggersAndRun = React.useCallback(
    async (action: () => void) => {
      if (!sessionId) {
        action();
        return;
      }
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/triggers?limit=50`,
          { credentials: "include" },
        );
        if (!res.ok) {
          action();
          return;
        }
        const data = (await res.json()) as { triggers: TriggerHistoryEntry[] };
        const incomplete = getIncompleteTriggers(data.triggers ?? []);
        if (incomplete.length > 0) {
          onIncompleteTriggers(incomplete, action);
        } else {
          action();
        }
      } catch {
        action();
      }
    },
    [sessionId, onIncompleteTriggers],
  );

  /** Fire a new_session exec (no confirmation). */
  const fireNewSession = React.useCallback(() => {
    if (onExec) {
      onExec({
        type: "exec",
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command: "new_session",
      });
    } else if (onSendInput) {
      void onSendInput({ text: "/new", files: [] });
    }
  }, [onExec, onSendInput]);

  const requestNewSession = React.useCallback(() => {
    void checkTriggersAndRun(fireNewSession);
  }, [checkTriggersAndRun, fireNewSession]);

  const executeSlashCommand = React.useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (!trimmed.startsWith("/")) return false;

      const [rawCommandInput, ...rest] = trimmed.slice(1).split(/\s+/);
      const rawCommand = rawCommandInput?.toLowerCase() ?? "";
      const args = rest.join(" ");
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      if (rawCommand === "new") {
        void requestNewSession();
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        return true;
      }

      if (rawCommand === "plugins") {
        if (!runnerId) {
          setInput("");
          setCommandOpen(false);
          setCommandQuery("");
          onAppendSystemMessage?.(
            "**Plugins** — Runner not connected yet. Try again in a moment.",
          );
          return true;
        }
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        const dispatchSessionId = sessionId;
        const pluginsUrl = sessionCwd
          ? `/api/runners/${encodeURIComponent(runnerId)}/plugins?cwd=${encodeURIComponent(sessionCwd)}`
          : `/api/runners/${encodeURIComponent(runnerId)}/plugins`;
        fetch(pluginsUrl, { credentials: "include" })
          .then((res) =>
            res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)),
          )
          .then((data: unknown) => {
            if (dispatchSessionId !== sessionIdRef.current) return;
            const raw = data as {
              plugins?: Array<{
                name: string; description?: string; version?: string;
                commands?: Array<{ name: string; description?: string }>;
                hookEvents?: string[]; skills?: Array<{ name: string }>;
                agents?: Array<{ name: string }>; rules?: Array<{ name: string }>;
                hasMcp?: boolean; hasAgents?: boolean;
              }>;
            };
            const plugins = Array.isArray(raw?.plugins) ? raw.plugins : [];
            onAppendSystemMessage?.({
              kind: "plugins",
              plugins: plugins.map((p) => ({
                name: p.name,
                description: p.description,
                version: p.version,
                commands: (p.commands ?? []).map((c) => ({
                  name: c.name,
                  description: c.description,
                })),
                hookCount: p.hookEvents?.length ?? 0,
                skillCount: p.skills?.length ?? 0,
                agentCount: p.agents?.length ?? 0,
                ruleCount: p.rules?.length ?? 0,
                hasMcp: !!p.hasMcp,
                hasAgents: !!p.hasAgents,
              })),
            });
          })
          .catch((err: Error) => {
            if (dispatchSessionId !== sessionIdRef.current) return;
            onAppendSystemMessage?.(`**Plugins** — Failed to load: ${err.message}`);
          });
        return true;
      }

      if (rawCommand === "skills") {
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        if (runnerInfo) {
          const skills = runnerInfo.skills ?? [];
          const merged = new Map<string, { name: string; description?: string }>();
          for (const s of skills) merged.set(s.name, s);
          for (const cmd of skillCommands) {
            const skillName = cmd.name.replace(/^skill:/, "");
            if (!merged.has(skillName)) {
              merged.set(skillName, { name: skillName, description: cmd.description });
            }
          }
          onAppendSystemMessage?.({ kind: "skills", skills: Array.from(merged.values()) });
        } else if (runnerId) {
          const dispatchSessionId = sessionId;
          fetch(`/api/runners/${encodeURIComponent(runnerId)}/skills`, {
            credentials: "include",
          })
            .then((res) =>
              res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)),
            )
            .then((data: unknown) => {
              if (dispatchSessionId !== sessionIdRef.current) return;
              const raw = data as { skills?: Array<{ name: string; description?: string }> };
              const fetchedSkills = Array.isArray(raw?.skills) ? raw.skills : [];
              const merged = new Map<string, { name: string; description?: string }>();
              for (const s of fetchedSkills) merged.set(s.name, s);
              for (const cmd of skillCommands) {
                const skillName = cmd.name.replace(/^skill:/, "");
                if (!merged.has(skillName))
                  merged.set(skillName, { name: skillName, description: cmd.description });
              }
              onAppendSystemMessage?.({
                kind: "skills",
                skills: Array.from(merged.values()),
              });
            })
            .catch((err: Error) => {
              if (dispatchSessionId !== sessionIdRef.current) return;
              onAppendSystemMessage?.(`**Skills** — Failed to load: ${err.message}`);
            });
        } else {
          onAppendSystemMessage?.(
            "**Skills** — Runner not connected yet. Try again in a moment.",
          );
        }
        return true;
      }

      if (rawCommand === "sandbox") {
        if (args.trim()) return false;
        if (!runnerId) {
          setInput("");
          setCommandOpen(false);
          setCommandQuery("");
          onAppendSystemMessage?.(
            "**Sandbox** — Runner not connected yet. Try again in a moment.",
          );
          return true;
        }
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        const dispatchSessionId = sessionId;
        fetch(`/api/runners/${encodeURIComponent(runnerId)}/sandbox-status`, {
          credentials: "include",
        })
          .then((res) =>
            res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)),
          )
          .then((data: unknown) => {
            if (dispatchSessionId !== sessionIdRef.current) return;
            const raw = data as {
              mode?: string; active?: boolean; platform?: string;
              violations?: number; recentViolations?: unknown[];
            };
            onAppendSystemMessage?.({
              kind: "sandbox" as const,
              mode: (raw.mode ?? "none") as "none" | "full" | "basic",
              active: raw.active ?? false,
              platform: raw.platform ?? "unknown",
              violations: raw.violations ?? 0,
              recentViolations: (Array.isArray(raw.recentViolations) ? raw.recentViolations : []) as SandboxViolationEntry[],
            });
          })
          .catch((err: Error) => {
            if (dispatchSessionId !== sessionIdRef.current) return;
            onAppendSystemMessage?.(`**Sandbox** — Failed to load: ${err.message}`);
          });
        return true;
      }

      if (rawCommand === "agents") {
        if (args.trim()) {
          const agentName = args.trim();
          if (onSpawnAgentSession && runnerId) {
            const dispatchSessionId = sessionId;
            const agentsList = runnerInfo?.agents ?? null;
            if (agentsList !== null) {
              const match = agentsList.find(
                (a) => a.name.toLowerCase() === agentName.toLowerCase(),
              );
              if (match) {
                fetch(
                  `/api/runners/${encodeURIComponent(runnerId)}/agents/${encodeURIComponent(match.name)}`,
                  { credentials: "include" },
                )
                  .then((res) => (res.ok ? res.json() : Promise.reject()))
                  .then((data: unknown) => {
                    if (dispatchSessionId !== sessionIdRef.current) return;
                    const raw = data as { content?: string };
                    onSpawnAgentSession?.({
                      name: match.name,
                      description: match.description,
                      systemPrompt: raw?.content,
                    });
                  })
                  .catch(() => {
                    if (dispatchSessionId !== sessionIdRef.current) return;
                    onSpawnAgentSession?.({ name: match.name, description: match.description });
                  });
              } else {
                onAppendSystemMessage?.(`**Agents** — Agent "${agentName}" not found.`);
              }
            } else {
              fetch(`/api/runners/${encodeURIComponent(runnerId)}/agents`, {
                credentials: "include",
              })
                .then((res) =>
                  res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)),
                )
                .then((data: unknown) => {
                  if (dispatchSessionId !== sessionIdRef.current) return;
                  const raw = data as {
                    agents?: Array<{ name: string; description?: string; content?: string }>;
                  };
                  const agents = Array.isArray(raw?.agents) ? raw.agents : [];
                  const match = agents.find(
                    (a) => a.name.toLowerCase() === agentName.toLowerCase(),
                  );
                  if (match) {
                    onSpawnAgentSession?.({
                      name: match.name,
                      description: match.description,
                      systemPrompt: match.content,
                    });
                  } else {
                    onAppendSystemMessage?.(`**Agents** — Agent "${agentName}" not found.`);
                  }
                })
                .catch((err: Error) => {
                  if (dispatchSessionId !== sessionIdRef.current) return;
                  onAppendSystemMessage?.(`**Agents** — Failed to load: ${err.message}`);
                });
            }
          }
        }
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        return true;
      }

      if (!onExec) return false;

      if (rawCommand === "mcp") {
        const argLower = args.trim().toLowerCase();
        if (argLower.startsWith("disable ") || argLower.startsWith("enable ")) {
          const isDisable = argLower.startsWith("disable ");
          const serverName = args.trim().slice(isDisable ? 8 : 7).trim();
          if (serverName) {
            onExec({ type: "exec", id, command: "mcp_toggle_server", serverName, disabled: isDisable });
          }
        } else if (argLower === "disable" || argLower === "enable") {
          onAppendSystemMessage?.(`Usage: \`/mcp ${argLower} <server-name>\``);
        } else {
          const action = argLower === "reload" ? "reload" : "status";
          onExec({ type: "exec", id, command: "mcp", action });
        }
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        return true;
      }

      if (rawCommand === "resume") {
        const selected = !args ? resumeSessions?.[0] : undefined;
        const resumeAction = () => {
          if (selected) {
            onExec({ type: "exec", id, command: "resume_session", sessionPath: selected.path });
          } else {
            onExec({ type: "exec", id, command: "resume_session", query: args || undefined });
          }
        };
        void checkTriggersAndRun(resumeAction);
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        return true;
      }

      if (rawCommand === "model" || rawCommand === "cycle_model") {
        if (onShowModelSelector) {
          onShowModelSelector();
        } else {
          onExec({ type: "exec", id, command: "cycle_model" });
        }
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        return true;
      }

      if (rawCommand === "effort" || rawCommand === "cycle_effort") {
        onExec({ type: "exec", id, command: "cycle_thinking_level" });
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        return true;
      }

      if (rawCommand === "compact") {
        if (isCompacting || compactingRef.current) return true;
        const dispatched = onExec({
          type: "exec",
          id,
          command: "compact",
          customInstructions: args || undefined,
        });
        if (dispatched !== false) {
          compactingRef.current = true;
        }
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        return true;
      }

      if (rawCommand === "name") {
        onExec({ type: "exec", id, command: "set_session_name", name: args });
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        return true;
      }

      if (rawCommand === "copy") {
        onExec({ type: "exec", id, command: "get_last_assistant_text" });
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        return true;
      }

      if (rawCommand === "stop") {
        onExec({ type: "exec", id, command: "abort" });
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        return true;
      }

      if (rawCommand === "restart") {
        onExec({ type: "exec", id, command: "restart" });
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        return true;
      }

      if (rawCommand === "plan") {
        onExec({ type: "exec", id, command: "set_plan_mode" });
        setInput("");
        setCommandOpen(false);
        setCommandQuery("");
        return true;
      }

      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      onExec,
      onSendInput,
      resumeSessions,
      runnerId,
      onAppendSystemMessage,
      skillCommands,
      sessionCwd,
      onShowModelSelector,
      isCompacting,
      sessionId,
      onSpawnAgentSession,
      runnerInfo,
      requestNewSession,
      checkTriggersAndRun,
      setInput,
      sessionIdRef,
      compactingRef,
    ],
  );

  return {
    commandOpen,
    setCommandOpen,
    commandQuery,
    setCommandQuery,
    commandHighlightedIndex,
    setCommandHighlightedIndex,
    executeSlashCommand,
    supportedWebCommands,
    knownCommandNames,
    keepPopoverOpenNames,
    commandSuggestions,
    skillSuggestions,
    extensionSuggestions,
    promptSuggestions,
    isResumeMode,
    isAgentMode,
    resumeQuery,
    resumeCandidates,
    checkTriggersAndRun,
    requestNewSession,
    resumeRequestedRef,
    subCommandMode,
    trimmedInput,
  };
}
