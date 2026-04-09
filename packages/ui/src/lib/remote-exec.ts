export type RemoteExecCommand =
  | { command: "get_commands" }
  | { command: "mcp"; action?: "status" | "reload" }
  | { command: "abort" }
  | { command: "set_model"; provider: string; modelId: string }
  | { command: "cycle_model" }
  | { command: "get_available_models" }
  | { command: "set_thinking_level"; level: string }
  | { command: "cycle_thinking_level" }
  | { command: "set_steering_mode"; mode: string }
  | { command: "set_follow_up_mode"; mode: string }
  | { command: "refresh_usage" }
  | { command: "compact"; customInstructions?: string }
  | { command: "set_session_name"; name: string }
  | { command: "get_last_assistant_text" }
  | { command: "list_resume_sessions"; limit?: number; cursor?: string }
  | { command: "resume_session"; query?: string; sessionPath?: string }
  | { command: "new_session" }
  | { command: "restart" }
  | { command: "end_session" }
  | { command: "mcp_toggle_server"; serverName: string; disabled: boolean }
  | { command: "set_plan_mode"; enabled?: boolean }
  | { command: "get_session_tree" }
  | { command: "navigate_tree"; targetId: string; summarize?: boolean; customInstructions?: string }
  | { command: "fork_session"; entryId: string };

export type RemoteExecRequest = { type: "exec"; id: string } & RemoteExecCommand;

// ── Session tree types ───────────────────────────────────────────────────────

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  role?: string;
  preview?: string;
  label?: string;
  isBranchPoint: boolean;
  children: SessionTreeNode[];
}

export interface SessionTreeResult {
  tree: SessionTreeNode[];
  leafId: string | null;
}

export type RemoteExecResponse =
  | { type: "exec_result"; id: string; ok: true; command: RemoteExecCommand["command"]; result?: any }
  | { type: "exec_result"; id: string; ok: false; command: string; error: string };

export function newExecId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
