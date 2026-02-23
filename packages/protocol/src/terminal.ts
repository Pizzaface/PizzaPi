// ============================================================================
// /terminal namespace — Browser terminal viewer ↔ Server
// ============================================================================

// ---------------------------------------------------------------------------
// Server → Client (Server sends to browser terminal viewer)
// ---------------------------------------------------------------------------

export interface TerminalServerToClientEvents {
  /** Confirms terminal viewer connection */
  terminal_connected: (data: {
    terminalId: string;
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
// Client → Server (Browser terminal viewer sends to server)
// ---------------------------------------------------------------------------

export interface TerminalClientToServerEvents {
  /** Sends input to the terminal */
  terminal_input: (data: {
    terminalId: string;
    data: string;
  }) => void;

  /** Resizes the terminal */
  terminal_resize: (data: {
    terminalId: string;
    cols: number;
    rows: number;
  }) => void;

  /** Kills the terminal */
  kill_terminal: (data: {
    terminalId: string;
  }) => void;
}

// ---------------------------------------------------------------------------
// Inter-server events
// ---------------------------------------------------------------------------

export interface TerminalInterServerEvents {
  // Reserved for future Redis adapter usage
}

// ---------------------------------------------------------------------------
// Per-socket metadata
// ---------------------------------------------------------------------------

export interface TerminalSocketData {
  terminalId?: string;
  userId?: string;
}
