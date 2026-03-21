export interface RelayMessage {
  key: string;
  role: string;
  timestamp?: number;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  toolInput?: unknown;
  isError?: boolean;
  thinking?: string;
  thinkingDuration?: number;
  /** Populated when role === "subAgentConversation" */
  subAgentTurns?: SubAgentTurn[];
  /** For assistant messages: reason the message stopped (e.g. "error", "stop", "aborted") */
  stopReason?: string;
  /** For assistant messages with stopReason === "error": the error description */
  errorMessage?: string;
  /** For compactionSummary / branchSummary messages: the summary text */
  summary?: string;
  /** For compactionSummary messages: token count before compaction */
  tokensBefore?: number;
  /** Structured details from tool results (e.g., subagent SubagentDetails) */
  details?: unknown;
  /**
   * True when this toolResult message is a synthetic streaming partial produced
   * by a `tool_execution_update` event (i.e. the tool is still in-flight).
   * These must NOT be treated as terminal results by deduplication logic.
   */
  isStreamingPartial?: boolean;
}

// ── Sub-agent conversation types ─────────────────────────────────────────────

export type SubAgentTurn =
  | SubAgentSentTurn
  | SubAgentReceivedTurn
  | SubAgentWaitingTurn
  | SubAgentCheckTurn;

/** A message sent TO a sub-agent session (send_message tool). */
export interface SubAgentSentTurn {
  type: "sent";
  sessionId: string;
  message: string;
  isStreaming: boolean;
  isError: boolean;
}

/** A message received FROM a sub-agent session (wait_for_message with a result). */
export interface SubAgentReceivedTurn {
  type: "received";
  fromSessionId: string;
  message: string;
}

/** Actively waiting for a message (wait_for_message, still streaming / no result yet). */
export interface SubAgentWaitingTurn {
  type: "waiting";
  fromSessionId?: string;
  timeout?: number;
  isTimedOut: boolean;
  isCancelled: boolean;
  isStreaming: boolean;
}

/** Results from check_messages (may contain 0+ messages). */
export interface SubAgentCheckTurn {
  type: "check";
  fromSessionId?: string;
  messages: Array<{ fromSessionId: string; message: string }>;
  isEmpty: boolean;
  isStreaming: boolean;
}
