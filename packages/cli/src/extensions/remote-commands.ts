export type RemoteExecRequest =
    | { type: "exec"; id: string; command: "get_commands" }
    | { type: "exec"; id: string; command: "mcp"; action?: "status" | "reload" }
    | { type: "exec"; id: string; command: "abort" }
    | { type: "exec"; id: string; command: "set_model"; provider: string; modelId: string }
    | { type: "exec"; id: string; command: "cycle_model" }
    | { type: "exec"; id: string; command: "get_available_models" }
    | { type: "exec"; id: string; command: "set_thinking_level"; level: string }
    | { type: "exec"; id: string; command: "cycle_thinking_level" }
    | { type: "exec"; id: string; command: "set_steering_mode"; mode: string }
    | { type: "exec"; id: string; command: "set_follow_up_mode"; mode: string }
    | { type: "exec"; id: string; command: "compact"; customInstructions?: string }
    | { type: "exec"; id: string; command: "set_session_name"; name: string }
    | { type: "exec"; id: string; command: "get_last_assistant_text" }
    | { type: "exec"; id: string; command: "list_resume_sessions" }
    | { type: "exec"; id: string; command: "resume_session"; query?: string; sessionPath?: string }
    | { type: "exec"; id: string; command: "export_html"; outputPath?: string }
    | { type: "exec"; id: string; command: "new_session" }
    | { type: "exec"; id: string; command: "restart" };

export type RemoteExecResponse =
    | { type: "exec_result"; id: string; ok: true; command: RemoteExecRequest["command"]; result?: unknown }
    | { type: "exec_result"; id: string; ok: false; command: string; error: string };
