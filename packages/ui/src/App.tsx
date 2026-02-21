import * as React from "react";
import { SessionSidebar, type DotState } from "@/components/SessionSidebar";
import { SessionViewer, type RelayMessage } from "@/components/SessionViewer";
import { ProviderIcon } from "@/components/ProviderIcon";
import { AuthPage } from "@/components/AuthPage";
import { ApiKeyManager } from "@/components/ApiKeyManager";
import { PizzaLogo } from "@/components/PizzaLogo";
import { authClient, useSession, signOut } from "@/lib/auth-client";
import { getRelayWsBase } from "@/lib/relay";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sun, Moon, LogOut, KeyRound, X, User, ChevronsUpDown, PanelLeftOpen } from "lucide-react";
import { UsageIndicator, type ProviderUsageMap } from "@/components/UsageIndicator";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorShortcut,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";

function toRelayMessage(raw: unknown, fallbackId: string): RelayMessage | null {
  if (!raw || typeof raw !== "object") return null;

  const msg = raw as Record<string, unknown>;
  const role = typeof msg.role === "string" ? msg.role : "message";
  const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : undefined;
  const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
  const id = typeof msg.id === "string" ? msg.id : undefined;

  const key = id
    ? `${role}:id:${id}`
    : toolCallId
      ? `${role}:tool:${toolCallId}`
      : timestamp !== undefined
        ? `${role}:ts:${timestamp}`
        : `${role}:fallback:${fallbackId}`;

  return {
    key,
    role,
    timestamp,
    content: msg.content,
    toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
    toolCallId: toolCallId || undefined,
    isError: msg.isError === true,
  };
}

function getAssistantToolCallIds(msg: RelayMessage): string[] {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return [];
  const ids: string[] = [];
  for (const block of msg.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "toolCall") continue;
    const id =
      typeof b.toolCallId === "string"
        ? b.toolCallId
        : typeof b.id === "string"
          ? b.id
          : "";
    if (id) ids.push(id);
  }
  return ids;
}

function normalizeMessages(rawMessages: unknown[]): RelayMessage[] {
  const all = rawMessages
    .map((m, i) => toRelayMessage(m, `snapshot-${i}`))
    .filter((m): m is RelayMessage => m !== null);

  // Drop no-timestamp assistant messages that are superseded by a later
  // timestamped assistant message. Two messages are considered the same turn
  // when they share at least one toolCallId, OR when the no-timestamp message
  // is immediately followed by a timestamped one (the original heuristic).
  //
  // This prevents streaming partials saved alongside the final message from
  // producing duplicate rows (e.g. thinking blocks appearing below tool cards).

  // Build a set of toolCallIds referenced by any timestamped assistant message.
  const timestampedToolCallIds = new Set<string>();
  for (const msg of all) {
    if (msg.role === "assistant" && msg.timestamp !== undefined) {
      for (const id of getAssistantToolCallIds(msg)) {
        timestampedToolCallIds.add(id);
      }
    }
  }

  const dropIndices = new Set<number>();
  for (let i = 0; i < all.length; i++) {
    const cur = all[i];
    if (cur.role !== "assistant" || cur.timestamp !== undefined) continue;

    // Original heuristic: immediately followed by a timestamped assistant message.
    const next = all[i + 1];
    if (next?.role === "assistant" && next.timestamp !== undefined) {
      dropIndices.add(i);
      continue;
    }

    // Extended heuristic: shares a toolCallId with any later timestamped assistant message.
    const ids = getAssistantToolCallIds(cur);
    if (ids.length > 0 && ids.some((id) => timestampedToolCallIds.has(id))) {
      dropIndices.add(i);
    }
  }

  if (dropIndices.size === 0) return all;
  return all.filter((_, i) => !dropIndices.has(i));
}

interface ConfiguredModelInfo {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

interface TokenUsageInfo {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface ResumeSessionOption {
  id: string;
  path: string;
  name: string | null;
  modified: string;
  firstMessage?: string;
}

interface SessionUiCacheEntry {
  messages: RelayMessage[];
  activeModel: ConfiguredModelInfo | null;
  sessionName: string | null;
  availableModels: ConfiguredModelInfo[];
  availableCommands: Array<{ name: string; description?: string }>;
  agentActive: boolean;
  effortLevel: string | null;
  tokenUsage: TokenUsageInfo | null;
  lastHeartbeatAt: number | null;
}

function normalizeModel(raw: unknown): ConfiguredModelInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const model = raw as Record<string, unknown>;
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  // Accept both `id` (availableModels shape) and `modelId` (buildSessionContext shape)
  const id = (typeof model.id === "string" ? model.id.trim() : "") ||
              (typeof model.modelId === "string" ? model.modelId.trim() : "");
  if (!provider || !id) return null;

  return {
    provider,
    id,
    name: typeof model.name === "string" ? model.name : undefined,
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
    contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
  };
}

function normalizeSessionName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Inject `durationSeconds` into thinking blocks that we've timed client-side. */
function augmentThinkingDurations(message: unknown, durations: Map<number, number>): unknown {
  if (!message || typeof message !== "object" || durations.size === 0) return message;
  const msg = message as Record<string, unknown>;
  if (!Array.isArray(msg.content)) return message;
  let changed = false;
  const content = msg.content.map((block, i) => {
    if (!block || typeof block !== "object") return block;
    const b = block as Record<string, unknown>;
    if (b.type === "thinking" && durations.has(i) && b.durationSeconds === undefined) {
      changed = true;
      return { ...b, durationSeconds: durations.get(i) };
    }
    return block;
  });
  return changed ? { ...msg, content } : message;
}

function normalizeModelList(rawModels: unknown[]): ConfiguredModelInfo[] {
  const deduped = new Map<string, ConfiguredModelInfo>();
  for (const raw of rawModels) {
    const model = normalizeModel(raw);
    if (!model) continue;
    deduped.set(`${model.provider}/${model.id}`, model);
  }
  return Array.from(deduped.values()).sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.id.localeCompare(b.id);
  });
}

export function App() {
  const { data: session, isPending } = useSession();
  const [isDark, setIsDark] = React.useState(() => {
    const saved = localStorage.getItem("theme");
    return saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches);
  });
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<RelayMessage[]>([]);
  const [viewerStatus, setViewerStatus] = React.useState("Idle");
  const [relayStatus, setRelayStatus] = React.useState<DotState>("connecting");
  const [showApiKeys, setShowApiKeys] = React.useState(false);
  const [pendingQuestion, setPendingQuestion] = React.useState<{ toolCallId: string; question: string; options?: string[] } | null>(null);
  const [activeToolCalls, setActiveToolCalls] = React.useState<Map<string, string>>(new Map());
  const [activeModel, setActiveModel] = React.useState<ConfiguredModelInfo | null>(null);
  const [sessionName, setSessionName] = React.useState<string | null>(null);
  const [availableModels, setAvailableModels] = React.useState<ConfiguredModelInfo[]>([]);
  const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false);
  const [isChangingModel, setIsChangingModel] = React.useState(false);

  // Live session status from heartbeats
  const [agentActive, setAgentActive] = React.useState(false);
  const [effortLevel, setEffortLevel] = React.useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = React.useState<TokenUsageInfo | null>(null);
  const [lastHeartbeatAt, setLastHeartbeatAt] = React.useState<number | null>(null);
  const [providerUsage, setProviderUsage] = React.useState<ProviderUsageMap | null>(null);

  // Sequence tracking for gap detection
  const lastSeqRef = React.useRef<number | null>(null);

  // Capabilities advertised by the runner (commands, models, etc.)
  const [availableCommands, setAvailableCommands] = React.useState<Array<{ name: string; description?: string }>>([]);

  // /resume picker state (fetched from runner session files)
  const [resumeSessions, setResumeSessions] = React.useState<ResumeSessionOption[]>([]);
  const [resumeSessionsLoading, setResumeSessionsLoading] = React.useState(false);

  // Mobile layout
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  // Prevent the underlying content from scrolling when the mobile sidebar is open.
  React.useEffect(() => {
    const prev = document.body.style.overflow;
    if (sidebarOpen) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sidebarOpen]);

  const viewerWsRef = React.useRef<WebSocket | null>(null);
  const activeSessionRef = React.useRef<string | null>(null);

  // Cache last-known UI state per relay session so switching sessions feels instant.
  const sessionUiCacheRef = React.useRef<Map<string, SessionUiCacheEntry>>(new Map());

  const patchSessionCache = React.useCallback((patch: Partial<SessionUiCacheEntry>) => {
    const sessionId = activeSessionRef.current;
    if (!sessionId) return;

    const prev = sessionUiCacheRef.current.get(sessionId);
    const next: SessionUiCacheEntry = {
      messages: prev?.messages ?? [],
      activeModel: prev?.activeModel ?? null,
      sessionName: prev?.sessionName ?? null,
      availableModels: prev?.availableModels ?? [],
      availableCommands: prev?.availableCommands ?? [],
      agentActive: prev?.agentActive ?? false,
      effortLevel: prev?.effortLevel ?? null,
      tokenUsage: prev?.tokenUsage ?? null,
      lastHeartbeatAt: prev?.lastHeartbeatAt ?? null,
      ...patch,
    };

    sessionUiCacheRef.current.set(sessionId, next);
  }, []);

  // Debounce streaming delta updates (toolcall_delta, text_delta, thinking_delta) so we
  // flush at most once per animation frame instead of once per character.
  const pendingDeltaRef = React.useRef<Map<string, { raw: unknown; key: string }>>(new Map());
  const deltaRafRef = React.useRef<number | null>(null);
  // Key of the in-flight streaming partial message; evicted when the final message lands.
  const streamingPartialKeyRef = React.useRef<string | null>(null);

  // Track wall-clock timing of thinking blocks so we can bake duration into the content.
  // contentIndex → Date.now() at thinking_start
  const thinkingStartTimesRef = React.useRef<Map<number, number>>(new Map());
  // contentIndex → elapsed seconds at thinking_end
  const thinkingDurationsRef = React.useRef<Map<number, number>>(new Map());

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    localStorage.setItem("theme", isDark ? "dark" : "light");
  }, [isDark]);

  React.useEffect(() => {
    return () => {
      viewerWsRef.current?.close();
      viewerWsRef.current = null;
    };
  }, []);

  const clearSelection = React.useCallback(() => {
    viewerWsRef.current?.close();
    viewerWsRef.current = null;
    activeSessionRef.current = null;
    lastSeqRef.current = null;
    setActiveSessionId(null);
    setMessages([]);
    setViewerStatus("Idle");
    setPendingQuestion(null);
    setActiveToolCalls(new Map());
    setActiveModel(null);
    setSessionName(null);
    setAvailableModels([]);
    setAvailableCommands([]);
    setResumeSessions([]);
    setResumeSessionsLoading(false);
    setModelSelectorOpen(false);
    setIsChangingModel(false);
    setAgentActive(false);
    setEffortLevel(null);
    setTokenUsage(null);
    setLastHeartbeatAt(null);
  }, []);

  // Full reset: cancel the RAF and wipe all pending streaming state. Use before
  // replacing the entire message list (session_active, agent_end) so a queued
  // RAF can't staple a stale partial on top of the fresh snapshot.
  const cancelPendingDeltas = React.useCallback(() => {
    if (deltaRafRef.current !== null) {
      cancelAnimationFrame(deltaRafRef.current);
      deltaRafRef.current = null;
    }
    pendingDeltaRef.current = new Map();
    streamingPartialKeyRef.current = null;
    thinkingStartTimesRef.current = new Map();
    thinkingDurationsRef.current = new Map();
  }, []);

  const upsertMessage = React.useCallback((raw: unknown, fallback: string, evictPartial = false) => {
    const next = toRelayMessage(raw, fallback);
    if (!next) return;

    if (evictPartial && streamingPartialKeyRef.current) {
      // Remove only the partial from the pending queue so the RAF can't
      // re-insert it after we evict it from state. We intentionally do NOT
      // clear streamingPartialKeyRef here — the setMessages callback below
      // still needs it to locate and splice out the partial from state.
      pendingDeltaRef.current.delete(streamingPartialKeyRef.current);
      if (pendingDeltaRef.current.size === 0 && deltaRafRef.current !== null) {
        cancelAnimationFrame(deltaRafRef.current);
        deltaRafRef.current = null;
      }
    }

    setMessages((prev) => {
      let base = prev;
      if (evictPartial && streamingPartialKeyRef.current && streamingPartialKeyRef.current !== next.key) {
        const partialIdx = base.findIndex((m) => m.key === streamingPartialKeyRef.current);
        if (partialIdx >= 0) {
          base = base.slice();
          base.splice(partialIdx, 1);
        }
        streamingPartialKeyRef.current = null;
      }
      const idx = base.findIndex((m) => m.key === next.key);
      if (idx >= 0) {
        const updated = base === prev ? base.slice() : base;
        updated[idx] = next;
        return updated;
      }
      return [...base, next];
    });
  }, []);

  const upsertMessageDebounced = React.useCallback((raw: unknown, fallback: string) => {
    const next = toRelayMessage(raw, fallback);
    if (!next) return;

    streamingPartialKeyRef.current = next.key;
    pendingDeltaRef.current.set(next.key, { raw, key: next.key });

    if (deltaRafRef.current === null) {
      deltaRafRef.current = requestAnimationFrame(() => {
        deltaRafRef.current = null;
        const pending = pendingDeltaRef.current;
        pendingDeltaRef.current = new Map();
        setMessages((prev) => {
          let result = prev;
          for (const { raw: pendingRaw, key } of pending.values()) {
            let msg = toRelayMessage(pendingRaw, key);
            if (!msg) continue;

            // Try to find an existing message by key
            let idx = result.findIndex((m) => m.key === msg!.key);

            // Heuristic: if not found, and it's a fallback key (streaming),
            // and the last message looks like a match (same role),
            // assume it's the target and ADOPT its key.
            if (idx === -1 && msg.key.includes(":fallback:")) {
              const lastIdx = result.length - 1;
              if (lastIdx >= 0) {
                const last = result[lastIdx];
                if (last.role === msg.role && !last.isError && last.timestamp !== undefined) {
                  // Inherit the key and timestamp from the existing message
                  // to maintain stability.
                  msg = { ...msg, key: last.key, timestamp: last.timestamp };
                  idx = lastIdx;
                }
              }
            }

            if (idx >= 0) {
              if (result === prev) result = prev.slice();
              result[idx] = msg;
            } else {
              if (result === prev) result = prev.slice();
              result.push(msg);
            }
          }
          return result;
        });
      });
    }
  }, []);

  const appendLocalSystemMessage = React.useCallback((text: string) => {
    const content = text.trim();
    if (!content) return;

    const now = Date.now();
    const message: RelayMessage = {
      key: `system:local:${now}:${Math.random().toString(16).slice(2)}`,
      role: "system",
      timestamp: now,
      content,
    };

    setMessages((prev) => {
      const next = [...prev, message];
      patchSessionCache({ messages: next });
      return next;
    });
  }, [patchSessionCache]);

  const handleRelayEvent = React.useCallback((event: unknown, seq?: number) => {
    if (!event || typeof event !== "object") return;

    const evt = event as Record<string, unknown>;
    const type = typeof evt.type === "string" ? evt.type : "";

    if (type === "heartbeat") {
      const hb = evt as {
        active?: boolean;
        model?: { provider: string; id: string; name?: string } | null;
        sessionName?: string | null;
        thinkingLevel?: string | null;
        tokenUsage?: TokenUsageInfo | null;
        ts?: number;
      };

      const nextAgentActive = hb.active === true;
      const cachePatch: Partial<SessionUiCacheEntry> = {
        agentActive: nextAgentActive,
      };

      setAgentActive(nextAgentActive);

      if (hb.thinkingLevel !== undefined) {
        const next = hb.thinkingLevel ?? null;
        setEffortLevel(next);
        cachePatch.effortLevel = next;
      }

      if (hb.tokenUsage !== undefined) {
        const next = hb.tokenUsage ?? null;
        setTokenUsage(next);
        cachePatch.tokenUsage = next;
      }

      if (typeof hb.ts === "number") {
        setLastHeartbeatAt(hb.ts);
        cachePatch.lastHeartbeatAt = hb.ts;
      }

      if ((hb as any).providerUsage !== undefined) {
        setProviderUsage((hb as any).providerUsage ?? null);
      }

      if (Object.prototype.hasOwnProperty.call(hb, "sessionName")) {
        const nextName = normalizeSessionName(hb.sessionName);
        setSessionName(nextName);
        cachePatch.sessionName = nextName;
      }

      // Heartbeats also carry the current model; keep activeModel in sync.
      if (hb.model) {
        const m = normalizeModel(hb.model);
        if (m) {
          setActiveModel(m);
          cachePatch.activeModel = m;
        }
      }

      patchSessionCache(cachePatch);
      return;
    }

    if (type === "capabilities") {
      const modelsRaw = Array.isArray((evt as any).models) ? ((evt as any).models as unknown[]) : [];
      const commandsRaw = Array.isArray((evt as any).commands) ? ((evt as any).commands as any[]) : [];

      const normalizedModels = normalizeModelList(modelsRaw);
      const normalizedCommands = commandsRaw
        .filter((c) => c && typeof c === "object" && typeof c.name === "string")
        .map((c) => ({ name: String(c.name), description: typeof c.description === "string" ? c.description : undefined }))
        .sort((a, b) => a.name.localeCompare(b.name));

      // Keep model state in sync with capability snapshots too.
      setAvailableModels(normalizedModels);
      setAvailableCommands(normalizedCommands);
      patchSessionCache({ availableModels: normalizedModels, availableCommands: normalizedCommands });
      return;
    }

    if (type === "session_active") {
      const state = evt.state as Record<string, unknown> | undefined;
      const rawMessages = Array.isArray(state?.messages) ? (state?.messages as unknown[]) : [];
      const stateModel = normalizeModel(state?.model);
      const stateModels = Array.isArray(state?.availableModels)
        ? normalizeModelList(state.availableModels as unknown[])
        : [];
      const normalizedMessages = normalizeMessages(rawMessages);
      const hasSessionName = !!state && Object.prototype.hasOwnProperty.call(state, "sessionName");
      const nextSessionName = hasSessionName ? normalizeSessionName(state?.sessionName) : null;

      // Flush any queued streaming-delta RAF before replacing state so stale
      // partials can't be re-inserted on top of the fresh snapshot.
      cancelPendingDeltas();
      setMessages(normalizedMessages);
      setActiveModel(stateModel);
      if (hasSessionName) {
        setSessionName(nextSessionName);
      }
      setAvailableModels(stateModels);

      // Don't clobber a transient status like "Model set" with a generic
      // "Connected" when the CLI sends a session_active snapshot right after.
      setViewerStatus((prev) => (prev === "Model set" ? prev : "Connected"));

      setPendingQuestion(null);
      setIsChangingModel(false);

      // Extract thinkingLevel from session snapshot too
      const thinkingLevel = typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null;
      setEffortLevel(thinkingLevel);

      patchSessionCache({
        messages: normalizedMessages,
        activeModel: stateModel,
        ...(hasSessionName ? { sessionName: nextSessionName } : {}),
        availableModels: stateModels,
        effortLevel: thinkingLevel,
      });
      return;
    }

    if (type === "agent_end" && Array.isArray(evt.messages)) {
      const normalized = normalizeMessages(evt.messages as unknown[]);
      cancelPendingDeltas();
      setMessages(normalized);
      patchSessionCache({ messages: normalized });
      setPendingQuestion(null);
      return;
    }

    if (type === "session_started") {
      // Runner emits { type: "session_started", model: { provider, modelId } }
      // Map modelId → id so normalizeModel can pick it up.
      const raw = evt.model as Record<string, unknown> | undefined;
      if (raw && typeof raw.modelId === "string") {
        const normalized = normalizeModel({ ...raw, id: raw.modelId });
        if (normalized) {
          setActiveModel(normalized);
          patchSessionCache({ activeModel: normalized });
        }
      }
      return;
    }

    if (type === "exec_result") {
      const ok = (evt as any).ok === true;
      const command = typeof (evt as any).command === "string" ? String((evt as any).command) : "";
      const result = (evt as any).result;
      if (!ok) {
        const error = typeof (evt as any).error === "string" ? (evt as any).error : "Command failed";
        if (command === "list_resume_sessions") {
          setResumeSessionsLoading(false);
        }
        setViewerStatus(`/${command}: ${error}`);
        return;
      }

      if (command === "list_resume_sessions") {
        const list: unknown[] = Array.isArray(result?.sessions) ? (result.sessions as unknown[]) : [];
        const normalized: ResumeSessionOption[] = [];

        for (const item of list) {
          if (!item || typeof item !== "object") continue;
          const entry = item as Record<string, unknown>;
          if (typeof entry.id !== "string" || typeof entry.path !== "string" || typeof entry.modified !== "string") {
            continue;
          }
          normalized.push({
            id: entry.id,
            path: entry.path,
            name: typeof entry.name === "string" ? entry.name : null,
            modified: entry.modified,
            firstMessage: typeof entry.firstMessage === "string" ? entry.firstMessage : undefined,
          });
        }

        setResumeSessions(normalized);
        setResumeSessionsLoading(false);
        if (normalized.length === 0) {
          setViewerStatus("No resumable sessions");
        }
        return;
      }

      if (command === "get_last_assistant_text") {
        const text = typeof result?.text === "string" ? result.text : "";
        if (text) {
          void navigator.clipboard.writeText(text);
          setViewerStatus("Copied");
        } else {
          setViewerStatus("Nothing to copy");
        }
        return;
      }

      if (command === "mcp") {
        const lines = Array.isArray(result?.lines)
          ? result.lines.filter((line: unknown): line is string => typeof line === "string")
          : [];
        if (lines.length > 0) {
          appendLocalSystemMessage(lines.join("\n"));
        }

        const summary = typeof result?.summary === "string"
          ? result.summary
          : typeof result?.toolCount === "number"
            ? `MCP tools loaded: ${result.toolCount}`
            : "MCP status updated";
        setViewerStatus(summary);
        return;
      }

      if (command === "cycle_thinking_level" || command === "set_thinking_level") {
        const newLevel = typeof result?.thinkingLevel === "string" ? result.thinkingLevel : null;
        setEffortLevel(newLevel);
        patchSessionCache({ effortLevel: newLevel });
        setViewerStatus(newLevel && newLevel !== "off" ? `Effort: ${newLevel}` : "Effort: off");
        return;
      }

      if (command === "set_session_name") {
        const nextSessionName = normalizeSessionName(result?.sessionName);
        setSessionName(nextSessionName);
        patchSessionCache({ sessionName: nextSessionName });
        setViewerStatus(nextSessionName ? "Session renamed" : "Session name cleared");
        return;
      }

      if (command === "set_model" || command === "cycle_model") {
        setViewerStatus("Model set");
        // Runner should also emit session_active/model_select, but in case it doesn't,
        // opportunistically refresh capabilities by asking for commands again (cheap).
        return;
      }

      if (command === "compact") {
        setViewerStatus("Compacted");
        return;
      }

      if (command === "new_session") {
        setViewerStatus("New session started");
        return;
      }

      if (command === "restart") {
        setViewerStatus("Restarting CLI…");
        return;
      }

      if (command === "resume_session") {
        setViewerStatus("Session resumed");
        return;
      }

      setViewerStatus("OK");
      return;
    }

    if (type === "model_select") {
      const selected = normalizeModel(evt.model);
      if (selected) {
        setActiveModel(selected);
        patchSessionCache({ activeModel: selected });
      }
      setIsChangingModel(false);
      return;
    }

    if (type === "model_set_result") {
      const ok = evt.ok === true;
      setIsChangingModel(false);
      if (ok) {
        // Keep wording consistent with "model_select" and make it clear the change succeeded.
        setViewerStatus("Model set");
      } else {
        const message = typeof evt.message === "string" ? evt.message : "Failed to set model";
        setViewerStatus(message);
      }
      return;
    }

    if (type === "tool_execution_start") {
      const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : "";
      const toolName = typeof evt.toolName === "string" ? evt.toolName : "unknown";
      if (toolCallId) {
        setActiveToolCalls((prev) => {
          const next = new Map(prev);
          next.set(toolCallId, toolName);
          return next;
        });
      }
    }

    if (type === "tool_execution_end") {
      const toolCallId = typeof evt.toolCallId === "string" ? evt.toolCallId : "";
      if (toolCallId) {
        setActiveToolCalls((prev) => {
          const next = new Map(prev);
          next.delete(toolCallId);
          return next;
        });
      }
    }

    if (type === "tool_execution_start" && evt.toolName === "AskUserQuestion") {
      const args = evt.args as Record<string, unknown> | undefined;
      const question = typeof args?.question === "string" ? args.question.trim() : "";
      const rawOptions = Array.isArray(args?.options) ? args.options : undefined;
      const options = rawOptions ? (rawOptions as unknown[]).filter((o): o is string => typeof o === "string") : undefined;

      if (question) {
        setPendingQuestion({
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : "ask-user-question",
          question,
          options,
        });
        setViewerStatus("Waiting for answer…");
      }
      return;
    }

    if (type === "tool_execution_update" && evt.toolName === "AskUserQuestion") {
      const partial = evt.partialResult as Record<string, unknown> | undefined;
      const details = partial?.details as Record<string, unknown> | undefined;
      const rawQuestion = typeof partial?.question === "string"
        ? partial.question
        : typeof details?.question === "string"
          ? details.question
          : "";
      const question = rawQuestion.trim();

      const rawOptions = (Array.isArray(partial?.options) ? partial.options : undefined)
        ?? (Array.isArray(details?.options) ? details.options : undefined);
      const options = rawOptions ? (rawOptions as unknown[]).filter((o): o is string => typeof o === "string") : undefined;

      if (question) {
        setPendingQuestion({
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : "ask-user-question",
          question,
          options,
        });
      }
      return;
    }

    if (type === "tool_execution_end" && evt.toolName === "AskUserQuestion") {
      setPendingQuestion(null);
      setViewerStatus("Connected");
      return;
    }

    if (type === "agent_end") {
      setActiveToolCalls(new Map());
    }

    if (type === "message_update") {
      const assistantEvent = evt.assistantMessageEvent as Record<string, unknown> | undefined;
      if (assistantEvent && assistantEvent.partial) {
        const deltaType = typeof assistantEvent.type === "string" ? assistantEvent.type : "";
        const contentIndex = typeof assistantEvent.contentIndex === "number" ? assistantEvent.contentIndex : -1;

        // Track wall-clock duration of each thinking block.
        if (deltaType === "thinking_start" && contentIndex >= 0) {
          thinkingStartTimesRef.current.set(contentIndex, Date.now());
        } else if (deltaType === "thinking_end" && contentIndex >= 0) {
          const startTime = thinkingStartTimesRef.current.get(contentIndex);
          if (startTime !== undefined) {
            const durationSeconds = Math.ceil((Date.now() - startTime) / 1000);
            thinkingDurationsRef.current.set(contentIndex, durationSeconds);
            thinkingStartTimesRef.current.delete(contentIndex);
          }
        }

        const isStreamingDelta =
          deltaType === "toolcall_delta" ||
          deltaType === "text_delta" ||
          deltaType === "thinking_delta";
        const partial = assistantEvent.partial as Record<string, unknown>;
        const raw = augmentThinkingDurations({ ...partial, timestamp: undefined }, thinkingDurationsRef.current);
        if (isStreamingDelta) {
          upsertMessageDebounced(raw, "message-update-partial");
        } else {
          upsertMessage(raw, "message-update-partial");
        }
        return;
      }
      upsertMessage(evt.message, "message-update");
      return;
    }

    if (type === "message_start") {
      upsertMessage(evt.message, type);
    }

    if (type === "message_end" || type === "turn_end") {
      upsertMessage(augmentThinkingDurations(evt.message, thinkingDurationsRef.current), type, true);
      // Reset for the next assistant message.
      thinkingStartTimesRef.current = new Map();
      thinkingDurationsRef.current = new Map();
    }
  }, [upsertMessage, upsertMessageDebounced, cancelPendingDeltas, appendLocalSystemMessage]);

  const openSession = React.useCallback((relaySessionId: string) => {
    viewerWsRef.current?.close();
    viewerWsRef.current = null;

    activeSessionRef.current = relaySessionId;
    lastSeqRef.current = null;
    setActiveSessionId(relaySessionId);
    setViewerStatus("Connecting…");
    setPendingQuestion(null);
    setActiveToolCalls(new Map());
    setIsChangingModel(false);
    setResumeSessions([]);
    setResumeSessionsLoading(false);

    const cached = sessionUiCacheRef.current.get(relaySessionId);
    setMessages(cached?.messages ?? []);
    setActiveModel(cached?.activeModel ?? null);
    setSessionName(cached?.sessionName ?? null);
    setAvailableModels(cached?.availableModels ?? []);
    setAvailableCommands(cached?.availableCommands ?? []);
    setAgentActive(cached?.agentActive ?? false);
    setEffortLevel(cached?.effortLevel ?? null);
    setTokenUsage(cached?.tokenUsage ?? null);
    setLastHeartbeatAt(cached?.lastHeartbeatAt ?? null);

    const ws = new WebSocket(`${getRelayWsBase()}/ws/sessions/${relaySessionId}`);
    viewerWsRef.current = ws;

    ws.onmessage = (evt) => {
      if (activeSessionRef.current !== relaySessionId) return;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(evt.data as string);
      } catch {
        return;
      }

      if (msg.type === "connected") {
        const replayOnly = msg.replayOnly === true;
        setViewerStatus(replayOnly ? "Snapshot replay" : "Connected");

        // Seed the last known sequence number so gap detection works from the start.
        if (typeof msg.lastSeq === "number") {
          lastSeqRef.current = msg.lastSeq;
        }

        // Reflect initial active status from connected message.
        if (typeof msg.isActive === "boolean") {
          setAgentActive(msg.isActive);
          patchSessionCache({ agentActive: msg.isActive });
        }

        if (Object.prototype.hasOwnProperty.call(msg, "sessionName")) {
          const nextName = normalizeSessionName((msg as any).sessionName);
          setSessionName(nextName);
          patchSessionCache({ sessionName: nextName });
        }

        // Tell the runner we connected so it can push capabilities (models/commands/etc.)
        try {
          ws.send(JSON.stringify({ type: "connected" }));
        } catch {}

        return;
      }

      if (msg.type === "event") {
        // Detect sequence gaps; request a resync if we missed events.
        const seq = typeof msg.seq === "number" ? msg.seq : null;
        if (seq !== null && lastSeqRef.current !== null) {
          const expected = lastSeqRef.current + 1;
          if (seq > expected) {
            // Gap detected — request a resync snapshot from the server.
            console.warn(`[relay] Sequence gap: expected ${expected}, got ${seq}. Requesting resync.`);
            try { ws.send(JSON.stringify({ type: "resync" })); } catch {}
          }
        }
        if (seq !== null) lastSeqRef.current = seq;

        handleRelayEvent(msg.event, seq ?? undefined);
        return;
      }

      if (msg.type === "exec_result") {
        handleRelayEvent(msg);
        return;
      }

      if (msg.type === "disconnected") {
        const reason = typeof msg.reason === "string" ? msg.reason : "Disconnected";
        setViewerStatus(reason);
        setPendingQuestion(null);
        setIsChangingModel(false);
        return;
      }

      if (msg.type === "error") {
        setViewerStatus(typeof msg.message === "string" ? msg.message : "Failed to load session");
      }
    };

    ws.onerror = () => {
      if (activeSessionRef.current === relaySessionId) {
        setViewerStatus("Connection error");
      }
    };

    ws.onclose = () => {
      if (activeSessionRef.current === relaySessionId) {
        setViewerStatus((prev) => (prev === "Connected" || prev === "Connecting…" ? "Disconnected" : prev));
        setPendingQuestion(null);
        setIsChangingModel(false);
      }
    };
  }, [handleRelayEvent]);

  const sendSessionInput = React.useCallback(async (message: { text: string; files?: Array<{ mediaType?: string; filename?: string; url?: string }> } | string) => {
    const ws = viewerWsRef.current;
    const sessionId = activeSessionRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId) {
      setViewerStatus("Not connected to a live session");
      return false;
    }

    const payload = typeof message === "string" ? { text: message, files: [] } : message;
    const trimmed = payload.text.trim();

    const rawFiles = (payload.files ?? [])
      .filter((f) => typeof f?.url === "string" && f.url.length > 0)
      .map((f) => ({
        mediaType: typeof f.mediaType === "string" ? f.mediaType : undefined,
        filename: typeof f.filename === "string" ? f.filename : undefined,
        url: f.url as string,
      }));

    let attachments: Array<{ attachmentId: string; filename?: string; mediaType?: string; size?: number; expiresAt?: string }> = [];

    if (rawFiles.length > 0) {
      const uploaded: Array<{ attachmentId: string; filename?: string; mediaType?: string; size?: number; expiresAt?: string }> = [];

      for (const [index, file] of rawFiles.entries()) {
        const displayName = file.filename || `attachment-${index + 1}`;
        setViewerStatus(`Uploading attachment ${index + 1}/${rawFiles.length}: ${displayName}`);

        const formData = new FormData();
        try {
          const blob = await fetch(file.url).then((res) => res.blob());
          const uploadFile = new File([blob], displayName, {
            type: file.mediaType || blob.type || "application/octet-stream",
          });
          formData.append("files", uploadFile);
        } catch {
          setViewerStatus(`Failed to prepare attachment: ${displayName}`);
          return false;
        }

        try {
          const uploadRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
            method: "POST",
            body: formData,
            credentials: "include",
          });

          if (!uploadRes.ok) {
            const body = await uploadRes.json().catch(() => null);
            const message = body && typeof body.error === "string" ? body.error : `Upload failed for ${displayName}`;
            setViewerStatus(message);
            return false;
          }

          const body = await uploadRes.json().catch(() => null) as any;
          const first = Array.isArray(body?.attachments) ? body.attachments[0] : null;
          if (!first || typeof first.attachmentId !== "string") {
            setViewerStatus(`Upload failed for ${displayName}`);
            return false;
          }

          uploaded.push({
            attachmentId: first.attachmentId as string,
            filename: typeof first.filename === "string" ? first.filename : undefined,
            mediaType: typeof first.mimeType === "string" ? first.mimeType : undefined,
            size: typeof first.size === "number" ? first.size : undefined,
            expiresAt: typeof first.expiresAt === "string" ? first.expiresAt : undefined,
          });
        } catch {
          setViewerStatus(`Upload failed for ${displayName}`);
          return false;
        }
      }

      attachments = uploaded;
      setViewerStatus(`Uploaded ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}. Sending…`);
    }

    try {
      ws.send(JSON.stringify({ type: "input", text: trimmed, attachments, client: "web" }));
      setViewerStatus("Connected");
      return true;
    } catch {
      setViewerStatus("Failed to send message");
      return false;
    }
  }, []);

  const sendRemoteExec = React.useCallback((payload: any) => {
    const ws = viewerWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionRef.current) {
      setViewerStatus("Not connected to a live session");
      return false;
    }
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      setViewerStatus("Failed to send command");
      return false;
    }
  }, []);

  const requestResumeSessions = React.useCallback(() => {
    if (!activeSessionRef.current) return false;
    setResumeSessionsLoading(true);
    const ok = sendRemoteExec({
      type: "exec",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command: "list_resume_sessions",
    });
    if (!ok) {
      setResumeSessionsLoading(false);
    }
    return ok;
  }, [sendRemoteExec]);

  const selectModel = React.useCallback((model: ConfiguredModelInfo) => {
    const ws = viewerWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionRef.current) {
      setViewerStatus("Not connected to a live session");
      return;
    }

    try {
      setIsChangingModel(true);
      setViewerStatus(`Switching model to ${model.provider}/${model.id}…`);
      ws.send(JSON.stringify({ type: "model_set", provider: model.provider, modelId: model.id }));
      setModelSelectorOpen(false);
    } catch {
      setIsChangingModel(false);
      setViewerStatus("Failed to change model");
    }
  }, []);

  const handleOpenSession = React.useCallback((id: string) => {
    openSession(id);
    setSidebarOpen(false);
  }, [openSession]);

  const handleClearSelection = React.useCallback(() => {
    clearSelection();
    setSidebarOpen(false);
  }, [clearSelection]);

  if (isPending) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <span className="text-muted-foreground text-sm">Loading…</span>
      </div>
    );
  }

  if (!session) {
    return <AuthPage onAuthenticated={() => authClient.$store.notify("$sessionSignal")} />;
  }

  const rawUser = session && typeof session === "object" ? (session as any).user : undefined;
  const userName = rawUser && typeof rawUser.name === "string" ? (rawUser.name as string) : "";
  const userEmail = rawUser && typeof rawUser.email === "string" ? (rawUser.email as string) : "";
  const userLabel = userName || userEmail || "Account";

  function relayStatusLabel(status: DotState) {
    if (status === "connected") return "Relay connected";
    if (status === "connecting") return "Connecting…";
    return "Relay disconnected";
  }

  function relayStatusDot(status: DotState) {
    return `inline-block h-2 w-2 rounded-full ${status === "connected" ? "bg-green-500 shadow-[0_0_4px_#22c55e80]" : status === "connecting" ? "bg-slate-400" : "bg-red-500"}`;
  }

  function initials(value: string) {
    const parts = value
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    return parts.map((p) => p[0]?.toUpperCase()).join("") || "U";
  }

  const activeModelKey = activeModel ? `${activeModel.provider}/${activeModel.id}` : "";
  const modelGroups = new Map<string, ConfiguredModelInfo[]>();
  for (const model of availableModels) {
    if (!modelGroups.has(model.provider)) modelGroups.set(model.provider, []);
    modelGroups.get(model.provider)!.push(model);
  }

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-background pp-safe-left pp-safe-right">
      <header className="flex items-center justify-between gap-3 border-b bg-background px-4 pb-2 pt-[calc(0.5rem_+_env(safe-area-inset-top))] flex-shrink-0">
        <div className="flex items-center gap-3 flex-shrink-0">
          <PizzaLogo />
          <span className="text-sm font-semibold">PizzaPi</span>
          <Separator orientation="vertical" className="h-5" />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={relayStatusDot(relayStatus)} />
            <span className="hidden sm:inline">{relayStatusLabel(relayStatus)}</span>
          </div>
          {providerUsage && (
            <>
              <Separator orientation="vertical" className="h-5" />
              <UsageIndicator usage={providerUsage} />
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={() => setIsDark((d) => !d)}
            aria-label="Toggle dark mode"
            title="Toggle dark mode"
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={() => setShowApiKeys(true)}
            aria-label="Manage API keys"
            title="Manage API keys"
          >
            <KeyRound className="h-4 w-4" />
          </Button>

          <div className="hidden md:flex">
            <ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen}>
              <ModelSelectorTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="max-w-80 gap-2"
                  disabled={!activeSessionId || availableModels.length === 0 || isChangingModel}
                  title={
                    !activeSessionId
                      ? "Select a live session first"
                      : availableModels.length === 0
                        ? "No configured models on this runner"
                        : "Select model"
                  }
                >
                  <span className="truncate text-left">
                    {activeModel
                      ? `${activeModel.provider}/${activeModel.id}`
                      : !activeSessionId
                        ? "No session selected"
                        : availableModels.length === 0
                          ? "No configured models"
                          : "Select model"}
                  </span>
                  <ChevronsUpDown className="h-3.5 w-3.5 opacity-70" />
                </Button>
              </ModelSelectorTrigger>
              <ModelSelectorContent className="sm:max-w-xl">
                <ModelSelectorInput placeholder="Search configured models…" />
                <ModelSelectorList>
                  <ModelSelectorEmpty>No configured models available.</ModelSelectorEmpty>
                  {Array.from(modelGroups.entries()).map(([provider, models]) => (
                    <ModelSelectorGroup key={provider} heading={provider}>
                      {models.map((model) => {
                        const modelKey = `${model.provider}/${model.id}`;
                        const isActive = modelKey === activeModelKey;
                        return (
                          <ModelSelectorItem
                            key={modelKey}
                            value={`${model.provider} ${model.id} ${model.name ?? ""}`}
                            onSelect={() => selectModel(model)}
                          >
                            <ModelSelectorLogo provider={model.provider} />
                            <ModelSelectorName>
                              <span className="font-medium">{model.name || model.id}</span>
                              <span className="ml-2 text-xs text-muted-foreground">{model.id}</span>
                            </ModelSelectorName>
                            {isActive && <ModelSelectorShortcut>Current</ModelSelectorShortcut>}
                          </ModelSelectorItem>
                        );
                      })}
                    </ModelSelectorGroup>
                  ))}
                </ModelSelectorList>
              </ModelSelectorContent>
            </ModelSelector>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[11px] font-semibold flex-shrink-0">
                  {initials(userLabel)}
                </span>
                <span className="hidden md:inline truncate text-left max-w-40">{userLabel}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{userName || "Signed in"}</span>
              </DropdownMenuLabel>
              {userEmail && (
                <div className="px-2 pb-1 text-xs text-muted-foreground truncate">{userEmail}</div>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setShowApiKeys(true)}>
                <KeyRound className="h-4 w-4" />
                API keys
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => signOut()}>
                <LogOut className="h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="pp-shell flex flex-1 min-h-0 overflow-hidden relative">
        <div
          className={
            "pp-sidebar-wrap absolute inset-y-0 left-0 z-40 w-72 max-w-[85vw] border-r border-sidebar-border bg-sidebar shadow-lg md:static md:z-auto md:w-auto md:max-w-none md:border-r-0 md:bg-transparent md:shadow-none " +
            (sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0")
          }
        >
          <SessionSidebar
            onOpenSession={handleOpenSession}
            onClearSelection={handleClearSelection}
            activeSessionId={activeSessionId}
            activeModel={activeModel}
            onRelayStatusChange={setRelayStatus}
          />
        </div>

        {/* Mobile overlay */}
        {sidebarOpen && (
          <button
            className="pp-sidebar-overlay absolute inset-0 z-30 bg-black/40 md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
            type="button"
          />
        )}

        <div className="flex flex-col flex-1 min-w-0 h-full">
          {/* Mobile: session nav bar */}
          <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 md:hidden flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2 text-xs"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open sidebar"
            >
              <PanelLeftOpen className="h-4 w-4" />
              Sessions
            </Button>
            {activeSessionId && (
              <span className="truncate text-xs text-muted-foreground inline-flex items-center gap-1.5 min-w-0">
                {activeModel?.provider && (
                  <ProviderIcon provider={activeModel.provider} className="size-3" />
                )}
                <span className="truncate">{sessionName || `Session ${activeSessionId.slice(0, 8)}…`}</span>
              </span>
            )}
          </div>

          <SessionViewer
            sessionId={activeSessionId}
            sessionName={sessionName}
            messages={messages}
            activeModel={activeModel}
            activeToolCalls={activeToolCalls}
            pendingQuestion={pendingQuestion}
            availableCommands={availableCommands}
            resumeSessions={resumeSessions}
            resumeSessionsLoading={resumeSessionsLoading}
            onRequestResumeSessions={requestResumeSessions}
            onSendInput={sendSessionInput}
            onExec={sendRemoteExec}
            agentActive={agentActive}
            effortLevel={effortLevel}
            tokenUsage={tokenUsage}
            lastHeartbeatAt={lastHeartbeatAt}
            viewerStatus={viewerStatus}
          />
        </div>

        {showApiKeys && (
          <div className="absolute inset-y-0 right-0 z-40 flex w-full max-w-md flex-col shadow-xl border-l bg-background">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-sm">API Keys</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowApiKeys(false)}
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <ApiKeyManager />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
