import * as React from "react";
import type { Socket } from "socket.io-client";
import type {
  ViewerServerToClientEvents,
  ViewerClientToServerEvents,
  MetaGoalStatus,
} from "@pizzapi/protocol";
import type { RelayMessage } from "@/components/SessionViewer";
import type { ProviderUsageMap } from "@/components/UsageIndicator";
import type { QuestionDisplayMode, QuestionType } from "@/lib/ask-user-questions";
import type { ConfiguredModelInfo, ResumeSessionOption, ForkMessageOption, QueuedMessage, TokenUsage } from "@/lib/types";

// ─── Session-scoped state ─────────────────────────────────────────────────────
// All fields below are reset atomically by clearSelection(). Adding new
// session-scoped state here ensures it is automatically included in the reset
// — nothing can be accidentally left stale when switching sessions.
export interface SessionState {
  viewerSocket: Socket<ViewerServerToClientEvents, ViewerClientToServerEvents> | null;
  messages: RelayMessage[];
  retryState: { errorMessage: string; detectedAt: number } | null;
  pendingQuestion: { toolCallId: string; questions: Array<{ question: string; options: string[]; type?: QuestionType }>; display: QuestionDisplayMode } | null;
  pendingPlan: { toolCallId: string; title: string; description: string | null; steps: Array<{ title: string; description?: string }> } | null;
  pluginTrustPrompt: { promptId: string; pluginNames: string[]; pluginSummaries: string[] } | null;
  pendingApproval: import("@pizzapi/protocol").MetaPendingApproval | null;
  activeToolCalls: Map<string, string>;
  mcpOAuthPastes: Array<{ serverName: string; authUrl: string; nonce: string; ts: number }>;
  messageQueue: QueuedMessage[];
  activeModel: ConfiguredModelInfo | null;
  sessionName: string | null;
  availableModels: ConfiguredModelInfo[];
  modelSelectorOpen: boolean;
  isChangingModel: boolean;
  agentActive: boolean;
  effortLevel: string | null;
  authSource: string | null;
  tokenUsage: TokenUsage | null;
  providerUsage: ProviderUsageMap | null;
  usageRefreshing: boolean;
  lastHeartbeatAt: number | null;
  availableCommands: Array<{ name: string; description?: string; source?: string }>;
  resumeSessions: ResumeSessionOption[];
  resumeSessionsLoading: boolean;
  resumeSessionsNextCursor: string | null;
  forkMessages: ForkMessageOption[];
  forkMessagesLoading: boolean;
  goal: MetaGoalStatus | null;
}

export function createInitialSessionState(): SessionState {
  return {
    viewerSocket: null,
    messages: [],
    retryState: null,
    pendingQuestion: null,
    pendingPlan: null,
    pluginTrustPrompt: null,
    pendingApproval: null,
    activeToolCalls: new Map(),
    mcpOAuthPastes: [],
    messageQueue: [],
    activeModel: null,
    sessionName: null,
    availableModels: [],
    modelSelectorOpen: false,
    isChangingModel: false,
    agentActive: false,
    effortLevel: null,
    authSource: null,
    tokenUsage: null,
    providerUsage: null,
    usageRefreshing: false,
    lastHeartbeatAt: null,
    availableCommands: [],
    resumeSessions: [],
    resumeSessionsLoading: false,
    resumeSessionsNextCursor: null,
    forkMessages: [],
    forkMessagesLoading: false,
    goal: null,
  };
}

/**
 * Owns the consolidated session-scoped state object plus one stable setter per
 * field. clearSelection() resets the whole object with a single
 * `setSessionState(createInitialSessionState())` call.
 *
 * Also owns `messagesRef` / `activeModelRef`, kept in sync via layout effects
 * so socket handlers can read the latest committed values.
 */
export function useSessionState() {
  // ─── Consolidated session state ─────────────────────────────────────────────
  // clearSelection() resets this entire object in a single atomic call.
  const [sessionState, setSessionState] = React.useState<SessionState>(createInitialSessionState);
  const { messages, activeModel } = sessionState;
  // Mirrors `agentActive` synchronously from inside setAgentActive so the
  // stale-connection watchdog can read it without a render.
  const agentActiveRef = React.useRef(false);

  // Thin setter wrappers — identical signatures to the original useState setters
  // so all existing call-sites compile unchanged. Each supports both direct
  // values and functional updates (React.SetStateAction<T>).
  const setViewerSocket = React.useCallback(
    (v: React.SetStateAction<SessionState["viewerSocket"]>) =>
      setSessionState((p: SessionState) => ({ ...p, viewerSocket: typeof v === "function" ? v(p.viewerSocket) : v })),
    []
  );
  const setMessages = React.useCallback(
    (v: React.SetStateAction<RelayMessage[]>) =>
      setSessionState((p: SessionState) => ({ ...p, messages: typeof v === "function" ? v(p.messages) : v })),
    []
  );
  const setRetryState = React.useCallback(
    (v: React.SetStateAction<SessionState["retryState"]>) =>
      setSessionState((p: SessionState) => ({ ...p, retryState: typeof v === "function" ? v(p.retryState) : v })),
    []
  );
  const setPendingQuestion = React.useCallback(
    (v: React.SetStateAction<SessionState["pendingQuestion"]>) =>
      setSessionState((p: SessionState) => ({ ...p, pendingQuestion: typeof v === "function" ? v(p.pendingQuestion) : v })),
    []
  );
  const setPendingPlan = React.useCallback(
    (v: React.SetStateAction<SessionState["pendingPlan"]>) =>
      setSessionState((p: SessionState) => ({ ...p, pendingPlan: typeof v === "function" ? v(p.pendingPlan) : v })),
    []
  );
  const setPendingApproval = React.useCallback(
    (v: React.SetStateAction<SessionState["pendingApproval"]>) =>
      setSessionState((p: SessionState) => ({ ...p, pendingApproval: typeof v === "function" ? v(p.pendingApproval) : v })),
    [],
  );
  const setPluginTrustPrompt = React.useCallback(
    (v: React.SetStateAction<SessionState["pluginTrustPrompt"]>) =>
      setSessionState((p: SessionState) => ({ ...p, pluginTrustPrompt: typeof v === "function" ? v(p.pluginTrustPrompt) : v })),
    []
  );
  const setActiveToolCalls = React.useCallback(
    (v: React.SetStateAction<Map<string, string>>) =>
      setSessionState((p: SessionState) => ({ ...p, activeToolCalls: typeof v === "function" ? v(p.activeToolCalls) : v })),
    []
  );
  const setMcpOAuthPastes = React.useCallback(
    (v: React.SetStateAction<SessionState["mcpOAuthPastes"]>) =>
      setSessionState((p: SessionState) => ({ ...p, mcpOAuthPastes: typeof v === "function" ? v(p.mcpOAuthPastes) : v })),
    []
  );
  const setMessageQueue = React.useCallback(
    (v: React.SetStateAction<QueuedMessage[]>) =>
      setSessionState((p: SessionState) => ({ ...p, messageQueue: typeof v === "function" ? v(p.messageQueue) : v })),
    []
  );
  const setActiveModel = React.useCallback(
    (v: React.SetStateAction<ConfiguredModelInfo | null>) =>
      setSessionState((p: SessionState) => ({ ...p, activeModel: typeof v === "function" ? v(p.activeModel) : v })),
    []
  );
  const setSessionName = React.useCallback(
    (v: React.SetStateAction<string | null>) =>
      setSessionState((p: SessionState) => ({ ...p, sessionName: typeof v === "function" ? v(p.sessionName) : v })),
    []
  );
  const setAvailableModels = React.useCallback(
    (v: React.SetStateAction<ConfiguredModelInfo[]>) =>
      setSessionState((p: SessionState) => ({ ...p, availableModels: typeof v === "function" ? v(p.availableModels) : v })),
    []
  );
  const setModelSelectorOpen = React.useCallback(
    (v: React.SetStateAction<boolean>) =>
      setSessionState((p: SessionState) => ({ ...p, modelSelectorOpen: typeof v === "function" ? v(p.modelSelectorOpen) : v })),
    []
  );
  const setIsChangingModel = React.useCallback(
    (v: React.SetStateAction<boolean>) =>
      setSessionState((p: SessionState) => ({ ...p, isChangingModel: typeof v === "function" ? v(p.isChangingModel) : v })),
    []
  );
  const setAgentActive = React.useCallback(
    (v: React.SetStateAction<boolean>) =>
      setSessionState((p: SessionState) => {
        const next = typeof v === "function" ? v(p.agentActive) : v;
        agentActiveRef.current = next;
        return { ...p, agentActive: next };
      }),
    []
  );
  const setEffortLevel = React.useCallback(
    (v: React.SetStateAction<string | null>) =>
      setSessionState((p: SessionState) => ({ ...p, effortLevel: typeof v === "function" ? v(p.effortLevel) : v })),
    []
  );
  const setAuthSource = React.useCallback(
    (v: React.SetStateAction<string | null>) =>
      setSessionState((p: SessionState) => ({ ...p, authSource: typeof v === "function" ? v(p.authSource) : v })),
    []
  );
  const setTokenUsage = React.useCallback(
    (v: React.SetStateAction<TokenUsage | null>) =>
      setSessionState((p: SessionState) => ({ ...p, tokenUsage: typeof v === "function" ? v(p.tokenUsage) : v })),
    []
  );
  const setProviderUsage = React.useCallback(
    (v: React.SetStateAction<ProviderUsageMap | null>) =>
      setSessionState((p: SessionState) => ({ ...p, providerUsage: typeof v === "function" ? v(p.providerUsage) : v })),
    []
  );
  const setUsageRefreshing = React.useCallback(
    (v: React.SetStateAction<boolean>) =>
      setSessionState((p: SessionState) => ({ ...p, usageRefreshing: typeof v === "function" ? v(p.usageRefreshing) : v })),
    []
  );
  const setLastHeartbeatAt = React.useCallback(
    (v: React.SetStateAction<number | null>) =>
      setSessionState((p: SessionState) => ({ ...p, lastHeartbeatAt: typeof v === "function" ? v(p.lastHeartbeatAt) : v })),
    []
  );
  const setAvailableCommands = React.useCallback(
    (v: React.SetStateAction<Array<{ name: string; description?: string; source?: string }>>) =>
      setSessionState((p: SessionState) => ({ ...p, availableCommands: typeof v === "function" ? v(p.availableCommands) : v })),
    []
  );
  const setResumeSessions = React.useCallback(
    (v: React.SetStateAction<ResumeSessionOption[]>) =>
      setSessionState((p: SessionState) => ({ ...p, resumeSessions: typeof v === "function" ? v(p.resumeSessions) : v })),
    []
  );
  const setResumeSessionsLoading = React.useCallback(
    (v: React.SetStateAction<boolean>) =>
      setSessionState((p: SessionState) => ({ ...p, resumeSessionsLoading: typeof v === "function" ? v(p.resumeSessionsLoading) : v })),
    []
  );
  const setResumeSessionsNextCursor = React.useCallback(
    (v: string | null) =>
      setSessionState((p: SessionState) => ({ ...p, resumeSessionsNextCursor: v })),
    []
  );
  const setGoal = React.useCallback(
    (v: React.SetStateAction<MetaGoalStatus | null>) =>
      setSessionState((p: SessionState) => ({ ...p, goal: typeof v === "function" ? v(p.goal) : v })),
    []
  );
  const setForkMessages = React.useCallback(
    (v: React.SetStateAction<ForkMessageOption[]>) =>
      setSessionState((p: SessionState) => ({ ...p, forkMessages: typeof v === "function" ? v(p.forkMessages) : v })),
    []
  );
  const setForkMessagesLoading = React.useCallback(
    (v: React.SetStateAction<boolean>) =>
      setSessionState((p: SessionState) => ({ ...p, forkMessagesLoading: typeof v === "function" ? v(p.forkMessagesLoading) : v })),
    []
  );
  // Ref kept in sync with `messages` via useLayoutEffect so we can read the
  // latest committed value in event handlers without needing functional updaters.
  // This lets us move patchSessionCache side effects OUT of setMessages updaters,
  // which would otherwise be called speculatively in React concurrent mode.
  const messagesRef = React.useRef<RelayMessage[]>(messages);
  React.useLayoutEffect(() => { messagesRef.current = messages; }, [messages]);
  const activeModelRef = React.useRef<ConfiguredModelInfo | null>(activeModel);
  React.useLayoutEffect(() => { activeModelRef.current = activeModel; }, [activeModel]);

  return {
    sessionState,
    setSessionState,
    agentActiveRef,
    messagesRef,
    activeModelRef,
    setViewerSocket,
    setMessages,
    setRetryState,
    setPendingQuestion,
    setPendingPlan,
    setPendingApproval,
    setPluginTrustPrompt,
    setActiveToolCalls,
    setMcpOAuthPastes,
    setMessageQueue,
    setActiveModel,
    setSessionName,
    setAvailableModels,
    setModelSelectorOpen,
    setIsChangingModel,
    setAgentActive,
    setEffortLevel,
    setAuthSource,
    setTokenUsage,
    setProviderUsage,
    setUsageRefreshing,
    setLastHeartbeatAt,
    setAvailableCommands,
    setResumeSessions,
    setResumeSessionsLoading,
    setResumeSessionsNextCursor,
    setGoal,
    setForkMessages,
    setForkMessagesLoading,
  };
}

export type SessionStateApi = ReturnType<typeof useSessionState>;
