#!/usr/bin/env bun
/**
 * PizzaPi Claude Code hook handler.
 * Invoked by Claude Code for each lifecycle event.
 * Forwards events to the bridge via Unix IPC socket.
 * IPC socket path is passed as --ipc <path> in argv.
 *
 * Usage: bun hook-handler.ts --ipc /path/to/bridge.sock
 *
 * For PermissionRequest events this script does NOT handle them —
 * --permission-prompt-tool stdio handles those on stdin/stdout.
 * This script handles: SessionStart, SessionEnd, PostToolUse,
 * PostToolUseFailure, Stop, SubagentStart, SubagentStop,
 * Notification, UserPromptSubmit, PreCompact.
 */

import { createConnection } from "node:net";
import { serializeFrame, type PluginMessage } from "../../runner/claude-code-ipc.js";

const args = process.argv.slice(2);
const ipcIdx = args.indexOf("--ipc");
const ipcPath = ipcIdx !== -1 ? args[ipcIdx + 1] : process.env.PIZZAPI_CC_BRIDGE_IPC;

if (!ipcPath) {
  process.exit(0); // no IPC path — fail gracefully
}

// Read hook input from stdin
let stdinData = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  stdinData += chunk;
}

let hookInput: Record<string, unknown>;
try {
  hookInput = JSON.parse(stdinData);
} catch {
  process.exit(0);
}

const eventType = hookInput.hook_event_name as string | undefined;
if (!eventType) process.exit(0);

// Events we care about — everything else exits silently
const FORWARDED_EVENTS = new Set([
  "SessionStart", "SessionEnd", "PostToolUse", "PostToolUseFailure",
  "Stop", "SubagentStart", "SubagentStop", "Notification",
  "UserPromptSubmit", "PreCompact",
]);

if (!FORWARDED_EVENTS.has(eventType)) process.exit(0);

const sessionId = hookInput.session_id as string | undefined ?? "unknown";
const msg: PluginMessage = {
  type: "hook_event",
  event: eventType,
  sessionId,
  data: hookInput,
};

// Connect to bridge IPC, send message, and exit
const socket = createConnection(ipcPath);

await new Promise<void>((resolve) => {
  socket.on("connect", () => {
    socket.write(serializeFrame(msg), () => {
      socket.end();
      resolve();
    });
  });
  socket.on("error", () => resolve()); // bridge not up yet — fail gracefully
});

process.exit(0);
