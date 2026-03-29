// ============================================================================
// /runner namespace — Runner daemon ↔ Server
// ============================================================================

import type { RunnerSkill, RunnerAgent, RunnerPlugin, RunnerHook, ServiceAnnounceData, ServiceEnvelope, SocketClientMetadata } from "./shared.js";

// ---------------------------------------------------------------------------
// Client → Server (Runner daemon sends to server)
// ---------------------------------------------------------------------------

export interface RunnerClientToServerEvents {
  /** Runner registers itself with the server */
  register_runner: (data: {
    name?: string;
    roots?: string[];
    runnerId?: string;
    runnerSecret?: string;
    skills?: RunnerSkill[];
    agents?: RunnerAgent[];
    plugins?: RunnerPlugin[];
    hooks?: RunnerHook[];
    version?: string;
    /** Node.js process.platform value (e.g. "darwin", "linux", "win32") */
    platform?: string;
  }) => void;

  /** Runner responds with its list of skills */
  skills_list: (data: {
    skills: RunnerSkill[];
    requestId?: string;
  }) => void;

  /** Runner responds with its list of discovered Claude Code plugins */
  plugins_list: (data: {
    plugins: RunnerPlugin[];
    requestId?: string;
    /** false when the scan was rejected (e.g. invalid cwd) */
    ok?: boolean;
    message?: string;
    /** true when this was a per-cwd scoped scan (should not overwrite global cache) */
    scoped?: boolean;
  }) => void;

  /** Runner responds with its list of agents */
  agents_list: (data: {
    agents: RunnerAgent[];
    requestId?: string;
  }) => void;

  /** Runner responds to an agent CRUD operation */
  agent_result: (data: {
    requestId?: string;
    ok: boolean;
    message?: string;
    agents?: RunnerAgent[];
    content?: string;
    name?: string;
  }) => void;

  /** Runner responds to a skill CRUD operation */
  skill_result: (data: {
    requestId?: string;
    ok: boolean;
    message?: string;
    skills?: RunnerSkill[];
    content?: string;
    name?: string;
  }) => void;

  /** Runner responds to a file operation */
  file_result: (data: {
    requestId?: string;
    ok?: boolean;
    [key: string]: unknown;
  }) => void;

  /** Runner responds with available models */
  models_list: (data: {
    requestId?: string;
    models: Array<{
      provider: string;
      id: string;
      name?: string;
      reasoning?: boolean;
      contextWindow?: number;
    }>;
    error?: string;
  }) => void;

  /** Runner responds with usage dashboard data */
  usage_data: (data: {
    requestId?: string;
    data: unknown; // UsageData shape — typed as unknown here to avoid protocol depending on CLI types
  }) => void;

  /** Runner reports a usage data error */
  usage_error: (data: {
    requestId?: string;
    error: string;
  }) => void;

  /** Runner forwards a session event from a worker */
  runner_session_event: (data: {
    sessionId: string;
    event: unknown;
  }) => void;

  /** Worker session is ready */
  session_ready: (data: {
    sessionId: string;
  }) => void;

  /** Worker session encountered an error */
  session_error: (data: {
    sessionId: string;
    message: string;
  }) => void;

  /** Worker session was killed */
  session_killed: (data: {
    sessionId: string;
  }) => void;

  /** Request the relay to disconnect an adopted session's worker socket.
   *  Used to kill sessions the daemon doesn't have a child process handle for. */
  disconnect_session: (data: {
    sessionId: string;
  }) => void;

  /** Generic service message from runner → relay → viewer.
   *  The relay forwards this verbatim; it does not inspect serviceId. */
  service_message: (envelope: ServiceEnvelope) => void;

  /** Announce which services this runner supports.
   *  Forwarded to all viewers watching sessions on this runner. */
  service_announce: (data: ServiceAnnounceData) => void;

  /** Report a warning (e.g. tunnel connection failure).
   *  Server stores the warning and broadcasts runner_updated to viewers. */
  runner_warning: (data: { message: string }) => void;

  /** Clear all warnings for this runner. */
  runner_warning_clear: (data?: Record<string, never>) => void;

  /** Terminal is ready for interaction */
  terminal_ready: (data: {
    terminalId: string;
  }) => void;

  /** Terminal output data */
  terminal_data: (data: {
    terminalId: string;
    data: string;
  }) => void;

  /** Terminal process exited */
  terminal_exit: (data: {
    terminalId: string;
    exitCode: number;
  }) => void;

  /** Terminal error */
  terminal_error: (data: {
    terminalId: string;
    message: string;
  }) => void;
}

// ---------------------------------------------------------------------------
// Server → Client (Server sends to runner daemon)
// ---------------------------------------------------------------------------

export interface RunnerServerToClientEvents {
  /** Confirms runner registration */
  runner_registered: (data: {
    runnerId: string;
    /** Sessions still connected to the relay that belong to this runner (for re-adoption after restart). */
    existingSessions?: Array<{
      sessionId: string;
      cwd: string;
    }>;
  }) => void;

  /** Instructs runner to spawn a new session */
  new_session: (data: {
    sessionId: string;
    cwd?: string;
    prompt?: string;
    model?: { provider: string; id: string };
    skills?: string[];
    /** Model keys hidden by the user, format: "provider/modelId". The worker should
     *  filter these from list_models tool results. */
    hiddenModels?: string[];
    /** Optional agent config — spawn the session "as" this agent. */
    agent?: {
      name: string;
      systemPrompt?: string;
      tools?: string;
      disallowedTools?: string;
    };
    /** ID of the parent session that spawned this one. */
    parentSessionId?: string;
  }) => void;

  /** Instructs runner to kill a session */
  kill_session: (data: {
    sessionId: string;
  }) => void;

  /** Notifies the runner that a session's worker disconnected from the relay.
   *  Allows the daemon to clean up its runningSessions map for adopted sessions. */
  session_ended: (data: {
    sessionId: string;
  }) => void;

  /** Requests a list of active sessions */
  list_sessions: (data: Record<string, never>) => void;

  /** Instructs runner to restart */
  restart: (data: Record<string, never>) => void;

  /** Instructs runner to shut down completely (no respawn) */
  shutdown: (data: Record<string, never>) => void;

  /** Health check ping */
  ping: (data: Record<string, never>) => void;

  /** Instructs runner to create a new terminal */
  new_terminal: (data: {
    terminalId: string;
    cwd?: string;
    shell?: string;
    cols?: number;
    rows?: number;
  }) => void;

  /** Sends input to a terminal */
  terminal_input: (data: {
    terminalId: string;
    data: string;
  }) => void;

  /** Resizes a terminal */
  terminal_resize: (data: {
    terminalId: string;
    cols: number;
    rows: number;
  }) => void;

  /** Instructs runner to kill a terminal */
  kill_terminal: (data: {
    terminalId: string;
  }) => void;

  /** Requests a list of active terminals */
  list_terminals: (data: Record<string, never>) => void;

  /** Requests a list of agents */
  list_agents: (data: {
    requestId?: string;
  }) => void;

  /** Creates a new agent */
  create_agent: (data: {
    requestId?: string;
    name: string;
    content: string;
  }) => void;

  /** Updates an existing agent */
  update_agent: (data: {
    requestId?: string;
    name: string;
    content: string;
  }) => void;

  /** Deletes an agent */
  delete_agent: (data: {
    requestId?: string;
    name: string;
  }) => void;

  /** Reads an agent's content */
  get_agent: (data: {
    requestId?: string;
    name: string;
  }) => void;

  /** Requests a list of skills */
  list_skills: (data: {
    requestId?: string;
  }) => void;

  /** Requests a list of discovered Claude Code plugins */
  list_plugins: (data: {
    requestId?: string;
    /** Optional cwd override for project-local plugin scanning */
    cwd?: string;
  }) => void;

  /** Creates a new skill */
  create_skill: (data: {
    requestId?: string;
    name: string;
    content: string;
  }) => void;

  /** Updates an existing skill */
  update_skill: (data: {
    requestId?: string;
    name: string;
    content: string;
  }) => void;

  /** Deletes a skill */
  delete_skill: (data: {
    requestId?: string;
    name: string;
  }) => void;

  /** Reads a skill's content */
  get_skill: (data: {
    requestId?: string;
    name: string;
  }) => void;

  /** Lists files in a directory */
  list_files: (data: {
    requestId?: string;
    cwd: string;
    path: string;
  }) => void;

  /** Recursively searches for files by name (respects .gitignore) */
  search_files: (data: {
    requestId?: string;
    cwd: string;
    query: string;
    limit?: number;
  }) => void;

  /** Reads a file's content */
  read_file: (data: {
    requestId?: string;
    cwd: string;
    path: string;
  }) => void;

  // Git operations (status, diff, branches, checkout, stage, unstage,
  // commit, push) are handled via the service_message channel with
  // serviceId="git". No dedicated socket events needed.

  /** Requests current sandbox status */
  sandbox_get_status: (data: {
    requestId?: string;
  }) => void;

  /** Updates sandbox configuration (global config) */
  sandbox_update_config: (data: {
    requestId?: string;
    config: Record<string, unknown>;
  }) => void;

  /** Requests available models from the runner */
  list_models: (data: {
    requestId?: string;
  }) => void;

  /** Requests usage dashboard data from the runner */
  get_usage: (data: {
    requestId?: string;
    range?: "7d" | "30d" | "90d" | "all";
  }) => void;

  /** Requests the full runner settings (config.json + settings.json) */
  settings_get_config: (data: {
    requestId?: string;
  }) => void;

  /** Updates a specific section of the runner settings */
  settings_update_section: (data: {
    requestId?: string;
    /** Which config section to update */
    section: string;
    /** The new value for that section */
    value: unknown;
  }) => void;

  /** Generic service message from viewer → relay → runner.
   *  The relay forwards this verbatim; it does not inspect serviceId. */
  service_message: (envelope: ServiceEnvelope) => void;

  /** Generic error */
  error: (data: {
    message: string;
  }) => void;
}

// ---------------------------------------------------------------------------
// Inter-server events
// ---------------------------------------------------------------------------

export interface RunnerInterServerEvents {
  // Reserved for future Redis adapter usage
}

// ---------------------------------------------------------------------------
// Per-socket metadata
// ---------------------------------------------------------------------------

export interface RunnerSocketData extends SocketClientMetadata {
  runnerId?: string;
  runnerName?: string | null;
  roots?: string[];
}
