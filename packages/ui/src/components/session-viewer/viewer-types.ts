import type { RelayMessage } from "@/components/session-viewer/types";
import type { TodoItem, TokenUsage, QueuedMessage, ResumeSessionOption } from "@/lib/types";
import type { TriggerCounts } from "@/hooks/useTriggerCount";
import type { QuestionDisplayMode } from "@/lib/ask-user-questions";
import type { CommandResultData } from "@/components/session-viewer/rendering";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";

export type { RelayMessage, TodoItem, TokenUsage, QueuedMessage, ResumeSessionOption };

/** A command entry (from availableCommands prop or derived lists). */
export type CmdEntry = { name: string; description?: string; source?: string };

export interface SessionViewerProps {
  sessionId: string | null;
  sessionName?: string | null;
  messages: RelayMessage[];
  /** Active model info for the current session (used to show provider indicator + context window) */
  activeModel?: { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number } | null;
  activeToolCalls?: Map<string, string>;
  pendingQuestion?: { toolCallId: string; questions: Array<{ question: string; options: string[]; type?: import("@/lib/ask-user-questions").QuestionType }>; display: QuestionDisplayMode } | null;
  /** Pending plan mode prompt — shown as a plan review panel */
  pendingPlan?: { toolCallId: string; title: string; description: string | null; steps: Array<{ title: string; description?: string }> } | null;
  /** Plugin trust prompt from the worker — shown as a confirmation dialog */
  pluginTrustPrompt?: { promptId: string; pluginNames: string[]; pluginSummaries: string[] } | null;
  /** Respond to the plugin trust prompt */
  onPluginTrustResponse?: (trusted: boolean) => void;
  availableCommands?: Array<{ name: string; description?: string; source?: string }>;
  resumeSessions?: ResumeSessionOption[];
  resumeSessionsLoading?: boolean;
  onRequestResumeSessions?: () => boolean | void;
  onSendInput?: (message: PromptInputMessage & { deliverAs?: "steer" | "followUp" } | string) => boolean | void | Promise<boolean | void>;
  onExec?: (payload: unknown) => boolean | void;
  onShowModelSelector?: () => void;
  /** Whether the agent is currently processing a turn */
  agentActive?: boolean;
  /** Whether the session is currently being compacted */
  isCompacting?: boolean;
  /** Current reasoning effort level (e.g. "low", "medium", "high", "off") */
  effortLevel?: string | null;

  /** Cumulative token usage for the session */
  tokenUsage?: TokenUsage | null;
  /** Unix ms timestamp of the most recent heartbeat from the CLI */
  lastHeartbeatAt?: number | null;
  /** Human-readable connection/activity status */
  viewerStatus?: string;
  /** Auto-retry state from the CLI (provider error being retried) */
  retryState?: { errorMessage: string; detectedAt: number } | null;
  /** Messages queued while the agent is active */
  messageQueue?: QueuedMessage[];
  /** Remove a single queued message */
  onRemoveQueuedMessage?: (id: string) => void;
  /** Edit the text of a queued message */
  onEditQueuedMessage?: (id: string, newText: string) => void;
  /** Clear all queued messages */
  onClearMessageQueue?: () => void;
  /** Toggle the terminal panel */
  onToggleTerminal?: () => void;
  /** Whether to show the terminal button */
  showTerminalButton?: boolean;
  /** Toggle the file explorer panel */
  onToggleFileExplorer?: () => void;
  /** Whether to show the file explorer button */
  showFileExplorerButton?: boolean;
  /** Toggle the git panel */
  onToggleGit?: () => void;
  /** Whether to show the git button */
  showGitButton?: boolean;
  /** Whether the terminal panel is currently open (used for mobile overflow menu state indicator) */
  isTerminalOpen?: boolean;
  /** Whether the file explorer panel is currently open (used for mobile overflow menu state indicator) */
  isFileExplorerOpen?: boolean;
  /** Whether the git panel is currently open (used for mobile overflow menu state indicator) */
  isGitOpen?: boolean;
  /** Toggle the triggers panel */
  onToggleTriggers?: () => void;
  /** Whether to show the triggers button */
  showTriggersButton?: boolean;
  /** Whether the triggers panel is currently open (used for mobile overflow menu state indicator) */
  isTriggersOpen?: boolean;
  /** Trigger counts — pending (incomplete) and subscriptions */
  triggerCount?: TriggerCounts;
  /** Extra buttons to render in the header bar (e.g. service panel toggles) */
  extraHeaderButtons?: React.ReactNode;
  /** Current agent todo list */
  todoList?: TodoItem[];
  /** Whether plan mode (read-only exploration) is currently active */
  planModeEnabled?: boolean;
  /** Runner ID for the current session (used for runner files API) */
  runnerId?: string;
  /** Absolute working directory of the current session (used as base for @-mention file paths) */
  sessionCwd?: string;
  /** Append a local system message to the conversation (string or structured data for card rendering) */
  onAppendSystemMessage?: (content: string | CommandResultData) => void;
  /** Spawn a new session configured as a specific agent */
  onSpawnAgentSession?: (agent: { name: string; description?: string; systemPrompt?: string; tools?: string; disallowedTools?: string }) => void;
  /** Respond to a trigger from a child session */
  onTriggerResponse?: (triggerId: string, response: string, action?: string, sourceSessionId?: string) => boolean | void | Promise<boolean>;
  /** Optimistically dismiss the pending question panel after a successful response */
  onQuestionDismiss?: () => void;
  /** Optimistically dismiss the pending plan panel after a successful response */
  onPlanDismiss?: () => void;
  /** Open the new-session dialog pre-filled with the same runner & working directory */
  onDuplicateSession?: () => void;
  /** Full runner data for the active session's runner — from the /runners WS feed */
  runnerInfo?: import("@pizzapi/protocol").RunnerInfo | null;
  /** Pending MCP OAuth paste prompts (localhost redirect not reachable remotely). */
  mcpOAuthPastes?: Array<{ serverName: string; authUrl: string; nonce: string; ts: number }>;
  /** Submit a pasted OAuth callback URL code to the runner. Resolves with delivery status. */
  onMcpOAuthPaste?: (nonce: string, code: string, state?: string) => Promise<{ ok: boolean; error?: string }>;
  /** Dismiss an MCP OAuth paste prompt. */
  onMcpOAuthPasteDismiss?: (serverName: string) => void;
  /** Disable an MCP server (from OAuth paste prompt). */
  onMcpServerDisable?: (serverName: string) => void;
}
