// ============================================================================
// /runner namespace — Runner daemon ↔ Server
// ============================================================================

import type { RunnerSkill } from "./shared.js";

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
  }) => void;

  /** Runner responds with its list of skills */
  skills_list: (data: {
    skills: RunnerSkill[];
    requestId?: string;
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
  }) => void;

  /** Instructs runner to spawn a new session */
  new_session: (data: {
    sessionId: string;
    cwd?: string;
    prompt?: string;
    model?: { provider: string; id: string };
    skills?: string[];
  }) => void;

  /** Instructs runner to kill a session */
  kill_session: (data: {
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

  /** Requests a list of skills */
  list_skills: (data: {
    requestId?: string;
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

  /** Reads a file's content */
  read_file: (data: {
    requestId?: string;
    cwd: string;
    path: string;
  }) => void;

  /** Requests git status */
  git_status: (data: {
    requestId?: string;
    cwd: string;
  }) => void;

  /** Requests git diff */
  git_diff: (data: {
    requestId?: string;
    cwd: string;
  }) => void;

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

export interface RunnerSocketData {
  runnerId?: string;
  runnerName?: string | null;
  roots?: string[];
}
