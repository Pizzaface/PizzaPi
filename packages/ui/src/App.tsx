import * as React from "react";
import { SessionSidebar, type DotState } from "@/components/SessionSidebar";
import { SessionViewer, type RelayMessage } from "@/components/SessionViewer";
import { AuthPage } from "@/components/AuthPage";
import { ApiKeyManager } from "@/components/ApiKeyManager";
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
  const key = toolCallId
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

function normalizeMessages(rawMessages: unknown[]): RelayMessage[] {
  const all = rawMessages
    .map((m, i) => toRelayMessage(m, `snapshot-${i}`))
    .filter((m): m is RelayMessage => m !== null);

  // Drop no-timestamp assistant messages that are immediately followed by a
  // timestamped assistant message — these are streaming partials saved alongside
  // the final message in the snapshot and would produce duplicate rows in the UI.
  const dropIndices = new Set<number>();
  for (let i = 0; i < all.length - 1; i++) {
    const cur = all[i];
    const next = all[i + 1];
    if (
      cur.role === "assistant" &&
      cur.timestamp === undefined &&
      next.role === "assistant" &&
      next.timestamp !== undefined
    ) {
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
  const [pendingQuestion, setPendingQuestion] = React.useState<{ toolCallId: string; question: string } | null>(null);
  const [activeToolCalls, setActiveToolCalls] = React.useState<Map<string, string>>(new Map());
  const [activeModel, setActiveModel] = React.useState<ConfiguredModelInfo | null>(null);
  const [availableModels, setAvailableModels] = React.useState<ConfiguredModelInfo[]>([]);
  const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false);
  const [isChangingModel, setIsChangingModel] = React.useState(false);

  // Capabilities advertised by the runner (commands, models, etc.)
  const [availableCommands, setAvailableCommands] = React.useState<Array<{ name: string; description?: string }>>([]);

  // Mobile layout
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  const viewerWsRef = React.useRef<WebSocket | null>(null);
  const activeSessionRef = React.useRef<string | null>(null);

  // Debounce streaming delta updates (toolcall_delta, text_delta, thinking_delta) so we
  // flush at most once per animation frame instead of once per character.
  const pendingDeltaRef = React.useRef<Map<string, { raw: unknown; key: string }>>(new Map());
  const deltaRafRef = React.useRef<number | null>(null);
  // Key of the in-flight streaming partial message; evicted when the final message lands.
  const streamingPartialKeyRef = React.useRef<string | null>(null);

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
    setActiveSessionId(null);
    setMessages([]);
    setViewerStatus("Idle");
    setPendingQuestion(null);
    setActiveToolCalls(new Map());
    setActiveModel(null);
    setAvailableModels([]);
    setModelSelectorOpen(false);
    setIsChangingModel(false);
  }, []);

  const upsertMessage = React.useCallback((raw: unknown, fallback: string, evictPartial = false) => {
    const next = toRelayMessage(raw, fallback);
    if (!next) return;

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
            const msg = toRelayMessage(pendingRaw, key);
            if (!msg) continue;
            const idx = result.findIndex((m) => m.key === key);
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

  const handleRelayEvent = React.useCallback((event: unknown) => {
    if (!event || typeof event !== "object") return;

    const evt = event as Record<string, unknown>;
    const type = typeof evt.type === "string" ? evt.type : "";

    if (type === "capabilities") {
      const modelsRaw = Array.isArray((evt as any).models) ? ((evt as any).models as unknown[]) : [];
      const commandsRaw = Array.isArray((evt as any).commands) ? ((evt as any).commands as any[]) : [];

      // Keep model state in sync with capability snapshots too.
      setAvailableModels(normalizeModelList(modelsRaw));
      setAvailableCommands(
        commandsRaw
          .filter((c) => c && typeof c === "object" && typeof c.name === "string")
          .map((c) => ({ name: String(c.name), description: typeof c.description === "string" ? c.description : undefined }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      return;
    }

    if (type === "session_active") {
      const state = evt.state as Record<string, unknown> | undefined;
      const rawMessages = Array.isArray(state?.messages) ? (state?.messages as unknown[]) : [];
      const stateModel = normalizeModel(state?.model);
      const stateModels = Array.isArray(state?.availableModels)
        ? normalizeModelList(state.availableModels as unknown[])
        : [];

      setMessages(normalizeMessages(rawMessages));
      setActiveModel(stateModel);
      setAvailableModels(stateModels);

      // Don't clobber a transient status like "Model set" with a generic
      // "Connected" when the CLI sends a session_active snapshot right after.
      setViewerStatus((prev) => (prev === "Model set" ? prev : "Connected"));

      setPendingQuestion(null);
      setIsChangingModel(false);
      return;
    }

    if (type === "agent_end" && Array.isArray(evt.messages)) {
      setMessages(normalizeMessages(evt.messages as unknown[]));
      setPendingQuestion(null);
      return;
    }

    if (type === "session_started") {
      // Runner emits { type: "session_started", model: { provider, modelId } }
      // Map modelId → id so normalizeModel can pick it up.
      const raw = evt.model as Record<string, unknown> | undefined;
      if (raw && typeof raw.modelId === "string") {
        const normalized = normalizeModel({ ...raw, id: raw.modelId });
        if (normalized) setActiveModel(normalized);
      }
      return;
    }

    if (type === "exec_result") {
      const ok = (evt as any).ok === true;
      const command = typeof (evt as any).command === "string" ? String((evt as any).command) : "";
      const result = (evt as any).result;
      if (!ok) {
        const error = typeof (evt as any).error === "string" ? (evt as any).error : "Command failed";
        setViewerStatus(`/${command}: ${error}`);
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

      setViewerStatus("OK");
      return;
    }

    if (type === "model_select") {
      const selected = normalizeModel(evt.model);
      if (selected) {
        setActiveModel(selected);
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
      if (question) {
        setPendingQuestion({
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : "ask-user-question",
          question,
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
      if (question) {
        setPendingQuestion({
          toolCallId: typeof evt.toolCallId === "string" ? evt.toolCallId : "ask-user-question",
          question,
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
        const isStreamingDelta =
          deltaType === "toolcall_delta" ||
          deltaType === "text_delta" ||
          deltaType === "thinking_delta";
        const partial = assistantEvent.partial as Record<string, unknown>;
        const raw = { ...partial, timestamp: undefined };
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
      upsertMessage(evt.message, type, true);
    }
  }, [upsertMessage, upsertMessageDebounced]);

  const openSession = React.useCallback((relaySessionId: string) => {
    viewerWsRef.current?.close();
    viewerWsRef.current = null;

    activeSessionRef.current = relaySessionId;
    setActiveSessionId(relaySessionId);
    setMessages([]);
    setViewerStatus("Connecting…");
    setPendingQuestion(null);
    setActiveToolCalls(new Map());
    setActiveModel(null);
    setAvailableModels([]);
    setIsChangingModel(false);

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

        // Tell the runner we connected so it can push capabilities (models/commands/etc.)
        try {
          ws.send(JSON.stringify({ type: "connected" }));
        } catch {}

        return;
      }

      if (msg.type === "event") {
        handleRelayEvent(msg.event);
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

  const sendSessionInput = React.useCallback((text: string) => {
    const ws = viewerWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeSessionRef.current) {
      setViewerStatus("Not connected to a live session");
      return false;
    }

    const trimmed = text.trim();

    try {
      // Always send raw user input as chat to the runner.
      // Slash commands are handled via the command palette (exec messages), not as chat text.
      ws.send(JSON.stringify({ type: "input", text: trimmed }));
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
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
      <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-2 flex-shrink-0">
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-sm font-semibold">PizzaPi</span>
          <Separator orientation="vertical" className="h-5" />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={relayStatusDot(relayStatus)} />
            <span className="hidden sm:inline">{relayStatusLabel(relayStatus)}</span>
          </div>
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
            onOpenSession={(id) => {
              openSession(id);
              setSidebarOpen(false);
            }}
            onClearSelection={() => {
              clearSelection();
              setSidebarOpen(false);
            }}
            activeSessionId={activeSessionId}
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
              <span className="truncate text-xs text-muted-foreground">
                Session {activeSessionId.slice(0, 8)}…
              </span>
            )}
          </div>

          <SessionViewer
            sessionId={activeSessionId}
            messages={messages}
            activeToolCalls={activeToolCalls}
            pendingQuestion={pendingQuestion?.question ?? null}
            availableCommands={availableCommands}
            onSendInput={sendSessionInput}
            onExec={sendRemoteExec}
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
