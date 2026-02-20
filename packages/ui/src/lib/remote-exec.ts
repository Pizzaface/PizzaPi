export type RemoteExecCommand =
  | { command: "get_commands" }
  | { command: "set_model"; provider: string; modelId: string }
  | { command: "cycle_model" }
  | { command: "get_available_models" }
  | { command: "set_thinking_level"; level: string }
  | { command: "cycle_thinking_level" }
  | { command: "set_steering_mode"; mode: string }
  | { command: "set_follow_up_mode"; mode: string }
  | { command: "compact"; customInstructions?: string }
  | { command: "set_session_name"; name: string }
  | { command: "get_last_assistant_text" }
  | { command: "new_session" };

export type RemoteExecRequest = { type: "exec"; id: string } & RemoteExecCommand;

export type RemoteExecResponse =
  | { type: "exec_result"; id: string; ok: true; command: RemoteExecCommand["command"]; result?: any }
  | { type: "exec_result"; id: string; ok: false; command: string; error: string };

export function newExecId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
