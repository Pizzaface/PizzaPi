// ── IPC Protocol Types ───────────────────────────────────────────────────
// All messages over the Unix socket are newline-delimited JSON.

// Plugin → Bridge
export type PluginMessage =
  | { type: "hook_event"; event: string; sessionId: string; data: unknown; requestId?: string }
  | { type: "mcp_call"; tool: string; args: unknown; requestId: string }
  | { type: "ready"; component: "hooks" | "mcp" };

// Bridge → Plugin
export type BridgeMessage =
  | { type: "hook_response"; requestId: string; decision: string; reason?: string }
  | { type: "mcp_response"; requestId: string; result: unknown; error?: string }
  | { type: "relay_input"; text: string; attachments?: unknown[] }
  | { type: "session_message"; fromSessionId: string; message: string }
  | { type: "trigger"; trigger: unknown }
  | { type: "shutdown" };

// ── Frame helpers ────────────────────────────────────────────────────────

/** Serialize a message to a newline-terminated JSON buffer. */
export function serializeFrame(msg: unknown): Buffer {
  return Buffer.from(JSON.stringify(msg) + "\n", "utf8");
}

/** Parse all complete newline-delimited JSON frames from a buffer.
 *  Returns parsed frames and any trailing incomplete bytes. */
export function framesFromBuffer(buf: Buffer): { frames: unknown[]; remaining: Buffer } {
  const frames: unknown[] = [];
  let start = 0;

  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { // \n
      const line = buf.slice(start, i).toString("utf8").trim();
      start = i + 1;
      if (!line) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        // Malformed frame — skip
      }
    }
  }

  return { frames, remaining: buf.slice(start) };
}
