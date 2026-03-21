/**
 * Claude Code bridge process.
 *
 * Spawned by the daemon instead of worker.ts for Claude Code sessions.
 * - Creates a private temp dir with Unix IPC socket
 * - Generates per-session hooks.json and mcp.json
 * - Connects to PizzaPi relay via Socket.IO
 * - Spawns `claude` CLI subprocess with stream-json flags
 * - Translates NDJSON stdout → relay events
 * - Injects relay input → claude stdin
 *
 * Environment vars (from daemon):
 *   PIZZAPI_SESSION_ID, PIZZAPI_WORKER_CWD, PIZZAPI_API_KEY,
 *   PIZZAPI_RELAY_URL, PIZZAPI_WORKER_PARENT_SESSION_ID
 */

import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import type { Server as NetServer, Socket as NetSocket } from "node:net";
import { io, type Socket } from "socket.io-client";
import type { RelayClientToServerEvents, RelayServerToClientEvents } from "@pizzapi/protocol";
import { randomUUID } from "node:crypto";
import { translateNdjsonLine } from "./claude-code-ndjson.js";
import { serializeFrame, framesFromBuffer, type PluginMessage, type BridgeMessage } from "./claude-code-ipc.js";
import { buildSpawnSessionBody } from "./claude-code-spawn-request.js";
import { renderTrigger } from "../extensions/triggers/registry.js";
import type { ConversationTrigger } from "../extensions/triggers/types.js";
import {
  needsChunkedDelivery, capOversizedMessages, computeChunkBoundaries,
} from "../extensions/remote.js";

const RELAY_DEFAULT = "ws://localhost:7492";

// ── Config from env ───────────────────────────────────────────────────────
const sessionId = process.env.PIZZAPI_SESSION_ID ?? randomUUID();
const cwd = process.env.PIZZAPI_WORKER_CWD ?? process.cwd();
const apiKey = process.env.PIZZAPI_API_KEY;
const relayUrl = (process.env.PIZZAPI_RELAY_URL ?? RELAY_DEFAULT).replace(/\/$/, "");
const parentSessionId = process.env.PIZZAPI_WORKER_PARENT_SESSION_ID ?? null;
const initialPrompt = process.env.PIZZAPI_WORKER_INITIAL_PROMPT ?? "";
const initialModelProvider = process.env.PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER?.trim() ?? "";
const initialModelId = process.env.PIZZAPI_WORKER_INITIAL_MODEL_ID?.trim() ?? "";

// Plugin dir: absolute path to the static plugin directory shipped with the CLI.
// The runner may execute from either src/runner/*.ts or dist/runner/*.js, but the
// plugin assets live under packages/cli/src/claude-code-plugin in this repo.
const PACKAGE_ROOT = resolvePath(new URL("../..", import.meta.url).pathname);
const PLUGIN_DIR_CANDIDATES = [
  join(PACKAGE_ROOT, "src", "claude-code-plugin"),
  join(PACKAGE_ROOT, "claude-code-plugin"),
];
const PLUGIN_DIR: string = (() => {
  const found = PLUGIN_DIR_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Claude Code plugin directory not found. Looked in: ${PLUGIN_DIR_CANDIDATES.join(", ")}`);
  }
  return found;
})();

// ── State ─────────────────────────────────────────────────────────────────
let tmpDir: string | null = null;
let ipcServer: NetServer | null = null;
let sioSocket: Socket<RelayServerToClientEvents, RelayClientToServerEvents> | null = null;
let claudeProcess: ReturnType<typeof Bun.spawn> | null = null;
let claudeSessionId: string = sessionId;
let relayToken: string | null = null;
let seq = 0;
let currentModel: string | null = null;
let messages: unknown[] = [];

// Track whether Claude is currently processing a turn (vs idle/waiting for input)
let claudeIsWorking = false;

// Pending AskUserQuestion: tool_use_id → { resolve, timer }
const pendingQuestions = new Map<string, { resolve: (answer: string) => void; timer: ReturnType<typeof setTimeout> }>();
// Pending permission requests: requestId → { resolve: (decision: "allow" | "deny") => void; timer: ReturnType<typeof setTimeout> };
const pendingPermissions = new Map<string, { resolve: (decision: "allow" | "deny") => void; timer: ReturnType<typeof setTimeout> }>();
// Pending triggers this session has received from linked children.
const receivedTriggers = new Map<string, { sourceSessionId: string; type: string; trackedAt: number }>();
const TRIGGER_TTL_MS = 10 * 60 * 1000;

// Buffered session messages from other sessions (for pizzapi_check_messages).
// Each entry: { fromSessionId, message }
const messageQueue: Array<{ fromSessionId: string; message: string }> = [];

// Pending message waiters: filters → resolver
// Allows pizzapi_wait_for_message to efficiently wait for matching messages
type MessageWaiter = {
  fromSessionIdFilter?: string;
  resolve: (msg: { fromSessionId: string; message: string }) => void;
  timer: ReturnType<typeof setTimeout>;
};
const messageWaiters: MessageWaiter[] = [];

// Generation counter — prevents stale watchClaudeExit from triggering shutdown
let processGeneration = 0;

function clearPendingState(): void {
  claudeIsWorking = false;
  for (const { timer } of pendingQuestions.values()) clearTimeout(timer);
  pendingQuestions.clear();
  pendingQuestionState.clear();
  for (const { timer } of pendingPermissions.values()) clearTimeout(timer);
  pendingPermissions.clear();
  for (const waiter of messageWaiters) clearTimeout(waiter.timer);
  messageWaiters.length = 0;
}

function trackReceivedTrigger(trigger: ConversationTrigger): void {
  if (receivedTriggers.has(trigger.triggerId)) return;
  receivedTriggers.set(trigger.triggerId, {
    sourceSessionId: trigger.sourceSessionId,
    type: trigger.type,
    trackedAt: Date.now(),
  });
  const now = Date.now();
  for (const [id, entry] of receivedTriggers) {
    if (now - entry.trackedAt > TRIGGER_TTL_MS) receivedTriggers.delete(id);
  }
}

function getReceivedTrigger(triggerId: string) {
  const pending = receivedTriggers.get(triggerId);
  if (!pending) return null;
  if (Date.now() - pending.trackedAt > TRIGGER_TTL_MS) {
    receivedTriggers.delete(triggerId);
    return null;
  }
  return pending;
}

/**
 * Handle an incoming session message.
 * Delivers to waiting listeners or buffers for later retrieval.
 */
function handleIncomingSessionMessage(data: { fromSessionId: string; message: string }): void {
  // Try to deliver to a waiting listener
  let waiterIdx = -1;
  for (let i = 0; i < messageWaiters.length; i++) {
    const waiter = messageWaiters[i];
    if (!waiter.fromSessionIdFilter || waiter.fromSessionIdFilter === data.fromSessionId) {
      clearTimeout(waiter.timer);
      messageWaiters.splice(i, 1);
      waiter.resolve(data);
      return;
    }
  }

  // No matching waiter — buffer the message
  messageQueue.push(data);
}

// ── IPC connected clients ─────────────────────────────────────────────────
const ipcClients = new Set<NetSocket>();

function broadcastToIpc(msg: BridgeMessage): void {
  const frame = serializeFrame(msg);
  for (const client of ipcClients) {
    if (!client.destroyed) client.write(frame);
  }
}

function sendToIpcClient(client: NetSocket, msg: BridgeMessage): void {
  if (!client.destroyed) client.write(serializeFrame(msg));
}

// ── Relay helpers ─────────────────────────────────────────────────────────
function relayHttpBase(): string {
  const base = relayUrl.replace(/\/ws\/sessions$/, "");
  if (base.startsWith("ws://")) return `http://${base.slice(5)}`;
  if (base.startsWith("wss://")) return `https://${base.slice(6)}`;
  return base;
}

function sioHttpUrl(): string {
  return relayUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/$/, "");
}

function forwardEvent(event: unknown): void {
  if (!sioSocket?.connected || !relayToken) return;
  sioSocket.emit("event", { sessionId, token: relayToken, event, seq: ++seq });
}

function emitHeartbeat(status?: string): void {
  const hb: Record<string, unknown> = {
    type: "heartbeat",
    workerType: "claude-code",
    active: claudeIsWorking,
    isAgentActive: claudeIsWorking,
    model: currentModel ? { provider: "anthropic", id: currentModel, name: currentModel } : null,
    ts: Date.now(),
    ...(status ? { status } : {}),
  };

  // Persist pending prompts in heartbeat so they restore on reconnect
  if (pendingQuestionState.size > 0) {
    const [toolCallId, pendingQ] = [...pendingQuestionState.entries()][0];
    hb.pendingQuestion = {
      toolCallId,
      questions: pendingQ.questions,
      display: "modal", // default to modal for Claude Code sessions
    };
  } else if (pendingQuestions.size > 0) {
    // Fallback: if we have an entry in pendingQuestions but not in pendingQuestionState
    // (shouldn't happen, but be defensive)
    const [toolCallId] = [...pendingQuestions.entries()][0];
    hb.pendingQuestion = {
      toolCallId,
      questions: [],
      display: "modal",
    };
  }

  if (pendingPermissions.size > 0) {
    const [requestId, _entry] = [...pendingPermissions.entries()][0];
    hb.pendingPermission = { requestId };
  }

  forwardEvent(hb);
}

// ── Temp dir and config file generation ──────────────────────────────────
async function setupTempDir(): Promise<{ ipcSocketPath: string; hooksPath: string; mcpPath: string }> {
  tmpDir = await mkdtemp(join(tmpdir(), "pizzapi-cc-"));
  await chmod(tmpDir, 0o700);

  const ipcSocketPath = join(tmpDir, "bridge.sock");

  const hooksJson = {
    hooks: Object.fromEntries(
      ["SessionStart","SessionEnd","PostToolUse","PostToolUseFailure",
       "Stop","SubagentStart","SubagentStop","Notification","UserPromptSubmit","PreCompact"].map(
        (evt) => [evt, [{ hooks: [{ type: "command", command: `bun "${PLUGIN_DIR}/scripts/hook-handler.ts" --ipc "${ipcSocketPath}"` }] }]]
      )
    ),
  };
  const hooksPath = join(tmpDir, "hooks.json");
  await writeFile(hooksPath, JSON.stringify(hooksJson, null, 2), { mode: 0o600 });

  const mcpJson = {
    mcpServers: {
      pizzapi: {
        command: "bun",
        args: [`${PLUGIN_DIR}/scripts/mcp-server.ts`],
        env: {
          PIZZAPI_CC_BRIDGE_IPC: ipcSocketPath,
          PIZZAPI_SESSION_ID: sessionId,
        },
      },
    },
  };
  const mcpPath = join(tmpDir, "mcp.json");
  await writeFile(mcpPath, JSON.stringify(mcpJson, null, 2), { mode: 0o600 });

  return { ipcSocketPath, hooksPath, mcpPath };
}

async function cleanupTempDir(): Promise<void> {
  if (tmpDir) {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
    tmpDir = null;
  }
}

// ── IPC server ────────────────────────────────────────────────────────────
function startIpcServer(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ipcServer = createNetServer((client) => {
      ipcClients.add(client);
      let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

      client.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const { frames, remaining } = framesFromBuffer(buf as Buffer<ArrayBuffer>);
        buf = remaining;
        for (const frame of frames) {
          handleIpcMessage(client, frame as PluginMessage);
        }
      });

      client.on("close", () => ipcClients.delete(client));
      client.on("error", () => ipcClients.delete(client));
    });

    ipcServer.listen(socketPath, () => resolve());
    ipcServer.on("error", reject);
  });
}

function handleIpcMessage(client: NetSocket, msg: PluginMessage): void {
  if (msg.type === "hook_event") {
    forwardEvent({ type: "hook_event", event: msg.event, ts: Date.now() });
  }

  if (msg.type === "mcp_call") {
    void handleMcpCall(client, msg.tool, msg.args as Record<string, unknown>, msg.requestId);
  }
}

async function handleMcpCall(
  client: NetSocket,
  tool: string,
  args: Record<string, unknown>,
  requestId: string,
): Promise<void> {
  try {
    const result = await dispatchMcpTool(tool, args);
    sendToIpcClient(client, { type: "mcp_response", requestId, result });
  } catch (err) {
    sendToIpcClient(client, { type: "mcp_response", requestId, result: null, error: err instanceof Error ? err.message : String(err) });
  }
}

async function dispatchMcpTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case "pizzapi_get_session_id":
      return sessionId;

    case "pizzapi_spawn_session": {
      const base = relayHttpBase();
      const resp = await fetch(`${base}/api/runners/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey ?? "" },
        body: JSON.stringify(buildSpawnSessionBody(args, sessionId)),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Spawn failed: HTTP ${resp.status}`);
      }
      return body;
    }

    case "pizzapi_send_message": {
      if (!sioSocket?.connected || !relayToken) throw new Error("Not connected to relay");
      sioSocket.emit("session_message", {
        token: relayToken,
        targetSessionId: String(args.sessionId ?? ""),
        message: String(args.message ?? ""),
      });
      return "sent";
    }

    case "pizzapi_wait_for_message": {
      const timeoutMs = Math.min(Number(args.timeout ?? 20) * 1000, 25_000);
      return new Promise<unknown>((resolve) => {
        // First check if there's an already-buffered message that matches
        const fromSessionIdFilter = typeof args.fromSessionId === "string" ? args.fromSessionId : undefined;
        let foundIdx = -1;

        if (!fromSessionIdFilter) {
          foundIdx = 0;
        } else {
          foundIdx = messageQueue.findIndex((m) => m.fromSessionId === fromSessionIdFilter);
        }

        if (foundIdx >= 0) {
          const msg = messageQueue.splice(foundIdx, 1)[0];
          resolve({ fromSessionId: msg.fromSessionId, message: msg.message });
          return;
        }

        // No buffered message — add to waiting list
        const timer = setTimeout(() => {
          const idx = messageWaiters.indexOf(waiter);
          if (idx >= 0) messageWaiters.splice(idx, 1);
          resolve(null);
        }, timeoutMs);

        const waiter: MessageWaiter = {
          fromSessionIdFilter,
          resolve: (msg) => resolve({ fromSessionId: msg.fromSessionId, message: msg.message }),
          timer,
        };
        messageWaiters.push(waiter);
      });
    }

    case "pizzapi_check_messages": {
      const fromSessionIdFilter = typeof args.fromSessionId === "string" ? args.fromSessionId : undefined;
      const result = fromSessionIdFilter
        ? messageQueue.filter((m) => m.fromSessionId === fromSessionIdFilter)
        : messageQueue.slice();

      if (fromSessionIdFilter) {
        // Remove the returned messages from the queue
        messageQueue.splice(
          0,
          messageQueue.length,
          ...messageQueue.filter((m) => m.fromSessionId !== fromSessionIdFilter),
        );
      } else {
        // Clear the entire queue
        messageQueue.length = 0;
      }

      return result.length > 0 ? result : null;
    }

    case "pizzapi_respond_to_trigger": {
      await respondToReceivedTrigger({
        triggerId: String(args.triggerId ?? ""),
        response: String(args.response ?? ""),
        ...(args.action ? { action: String(args.action) } : {}),
      });
      return "sent";
    }

    case "pizzapi_tell_child":
      await deliverInputMessageToSession(String(args.sessionId ?? ""), String(args.message ?? ""));
      return "sent";

    case "pizzapi_escalate_trigger":
      await escalateReceivedTrigger(String(args.triggerId ?? ""), typeof args.context === "string" ? args.context : undefined);
      return "sent";

    case "pizzapi_list_models":
      return { models: [] };

    default:
      throw new Error(`Unknown PizzaPi tool: ${tool}`);
  }
}

async function deliverInputMessageToSession(targetSessionId: string, message: string): Promise<void> {
  if (!targetSessionId) throw new Error("Missing target session ID");
  if (!sioSocket?.connected || !relayToken) throw new Error("Not connected to relay");
  const socket = sioSocket;
  const token = relayToken;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("session_message_error" as any, onError);
      resolve();
    }, 3000);

    const onError = (err: { targetSessionId: string; error: string }) => {
      if (err.targetSessionId !== targetSessionId) return;
      clearTimeout(timeout);
      socket.off("session_message_error" as any, onError);
      reject(new Error(err.error));
    };

    socket.on("session_message_error" as any, onError);
    socket.emit("session_message", {
      token,
      targetSessionId,
      message,
      deliverAs: "input",
    });
  });
}

async function cleanupChildSession(childSessionId: string): Promise<void> {
  if (!childSessionId) throw new Error("Missing child session ID");
  if (!sioSocket?.connected || !relayToken) throw new Error("Not connected to relay");
  const socket = sioSocket;
  const token = relayToken;

  const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const timeout = setTimeout(() => resolve({ ok: false, error: "Cleanup ack timed out" }), 10_000);
    socket.emit("cleanup_child_session", {
      token,
      childSessionId,
    }, (ack: { ok: boolean; error?: string }) => {
      clearTimeout(timeout);
      resolve(ack ?? { ok: true });
    });
  });

  if (!result.ok) {
    throw new Error(result.error ?? `Failed to clean up child session ${childSessionId}`);
  }
}

async function respondToReceivedTrigger(data: { triggerId: string; response: string; action?: string }): Promise<void> {
  if (!data.triggerId) throw new Error("Missing trigger ID");
  const pending = getReceivedTrigger(data.triggerId);
  if (!pending) throw new Error(`No pending trigger with ID ${data.triggerId}`);
  if (!sioSocket?.connected || !relayToken) throw new Error("Not connected to relay");

  if (pending.type === "session_complete") {
    const action = data.action ?? "ack";
    if (action === "followUp") {
      await deliverInputMessageToSession(pending.sourceSessionId, data.response);
      receivedTriggers.delete(data.triggerId);
      return;
    }
    await cleanupChildSession(pending.sourceSessionId);
    receivedTriggers.delete(data.triggerId);
    return;
  }

  sioSocket.emit("trigger_response", {
    token: relayToken,
    triggerId: data.triggerId,
    response: data.response,
    ...(data.action ? { action: data.action } : {}),
    targetSessionId: pending.sourceSessionId,
  });
  receivedTriggers.delete(data.triggerId);
}

async function escalateReceivedTrigger(triggerId: string, context?: string): Promise<void> {
  const pending = getReceivedTrigger(triggerId);
  if (!pending) throw new Error(`No pending trigger with ID ${triggerId}`);
  if (!sioSocket?.connected || !relayToken) throw new Error("Not connected to relay");

  sioSocket.emit("session_trigger" as any, {
    token: relayToken,
    trigger: {
      type: "escalate",
      sourceSessionId: pending.sourceSessionId,
      targetSessionId: sessionId,
      payload: { reason: context ?? "Parent escalated", originalTriggerId: triggerId },
      deliverAs: "steer" as const,
      expectsResponse: true,
      triggerId,
      ts: new Date().toISOString(),
    },
  });
}

// ── Claude subprocess ─────────────────────────────────────────────────────
function spawnClaude(tmpDirPath: string, resume = false): void {
  _stdoutBuf = "";  // reset on every spawn
  processGeneration++;
  const myGeneration = processGeneration;

  const mcpPath = join(tmpDirPath, "mcp.json");
  const hooksPath = join(tmpDirPath, "hooks.json");

  // `--settings` is a verified Claude Code flag (accepts path to settings JSON).
  // The settings file contains the `hooks` key for per-session hook delivery.
  const cliArgs = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--replay-user-messages",
    "--permission-prompt-tool", "stdio",
    "--session-id", claudeSessionId,
    "--plugin-dir", PLUGIN_DIR,
    "--mcp-config", mcpPath,
    "--settings", hooksPath,
    "--add-dir", cwd,
    ...(initialModelId
      ? initialModelProvider && initialModelProvider !== "anthropic"
        ? []
        : ["--model", initialModelId]
      : []),
    ...(resume ? ["--resume", claudeSessionId] : []),
  ];

  if (initialModelId && initialModelProvider && initialModelProvider !== "anthropic") {
    console.warn(`[bridge] ignoring unsupported initial model provider for Claude Code worker: ${initialModelProvider}`);
  }

  const command = resume
    ? ["claude", ...cliArgs]
    : ["claude", "-p", initialPrompt, ...cliArgs];

  claudeProcess = Bun.spawn(command, {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PIZZAPI_CC_BRIDGE_IPC: join(tmpDirPath, "bridge.sock"),
      PIZZAPI_SESSION_ID: sessionId,
    },
  });

  void readClaudeStdout();
  void readClaudeStderr();
  void watchClaudeExit(tmpDirPath, myGeneration);
}

function writeToClaudeStdin(msg: unknown): void {
  if (!claudeProcess?.stdin) return;
  const data = JSON.stringify(msg) + "\n";
  (claudeProcess.stdin as any).write(data);
}

const _stdoutDecoder = new TextDecoder();
const _stderrDecoder = new TextDecoder();
let _stdoutBuf = "";

async function readClaudeStdout(): Promise<void> {
  if (!claudeProcess?.stdout) return;
  // Bun subprocess stdout is a ReadableStream — use async iteration
  for await (const chunk of claudeProcess.stdout as AsyncIterable<Uint8Array>) {
    processStdoutChunk(chunk);
  }
}

function processStdoutChunk(chunk: Uint8Array): void {
  const text = _stdoutDecoder.decode(chunk, { stream: true });
  _stdoutBuf += text;
  const lines = _stdoutBuf.split("\n");
  _stdoutBuf = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim()) handleNdjsonLine(line);
  }
}

async function readClaudeStderr(): Promise<void> {
  if (!claudeProcess?.stderr) return;
  for await (const chunk of claudeProcess.stderr as AsyncIterable<Uint8Array>) {
    const text = _stderrDecoder.decode(chunk, { stream: true });
    if (text.trim()) console.error("[claude stderr]", text.trimEnd());
  }
}

async function watchClaudeExit(tmpDirPath: string, generation: number): Promise<void> {
  if (!claudeProcess) return;
  const exitCode = await claudeProcess.exited;
  claudeProcess = null;

  // If a newer process has been spawned since, this watcher is stale
  if (generation !== processGeneration) return;

  if (exitCode === 43) {
    console.log("[bridge] Claude exited with code 43 — restarting with --resume");
    spawnClaude(tmpDirPath, true);
    return;
  }

  shutdown(exitCode === 0 ? "completed" : "error");
}

// ── NDJSON event handling ─────────────────────────────────────────────────
function handleNdjsonLine(line: string): void {
  const result = translateNdjsonLine(line);

  if (result.kind === "control_request") {
    if (result.controlRequestId && result.toolName) {
      handleControlRequest(result.controlRequestId, result.toolName, result.toolInput);
    }
    return;
  }

  if (result.kind === "session_init") {
    if (result.sessionId) claudeSessionId = result.sessionId;
    if (result.model) currentModel = result.model;
    claudeIsWorking = false;
    emitSessionActive();
    return;
  }

  if (result.kind === "ask_user_question") {
    if (result.toolCallId) {
      handleAskUserQuestion(result.toolCallId, result.questions ?? []);
    }
    return;
  }

  if (result.kind === "relay_event" && result.relayEvent) {
    if (result.todoList) {
      forwardEvent({ type: "todo_update", todos: result.todoList, ts: Date.now() });
    }
    if (result.relayEvent.type === "message_update") {
      messages.push(result.relayEvent.message);
      claudeIsWorking = true;  // Claude is actively working/outputting
    } else if (result.relayEvent.type === "agent_end") {
      claudeIsWorking = false;  // Turn complete, Claude is now idle
    }
    forwardEvent(result.relayEvent);
  }
}

// ── Permission request via control protocol ───────────────────────────────
function handleControlRequest(requestId: string, toolName: string, toolInput: unknown): void {
  forwardEvent({
    type: "permission_request",
    requestId,
    toolName,
    toolInput,
    ts: Date.now(),
  });

  const timer = setTimeout(() => {
    pendingPermissions.delete(requestId);
    sendPermissionResponse(requestId, "deny");
  }, 5 * 60 * 1000);

  pendingPermissions.set(requestId, { resolve: (decision) => {
    clearTimeout(timer);
    pendingPermissions.delete(requestId);
    sendPermissionResponse(requestId, decision);
  }, timer });
}

function sendPermissionResponse(requestId: string, behavior: "allow" | "deny"): void {
  writeToClaudeStdin({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "Denied via PizzaPi web UI" },
    },
  });
}

// ── AskUserQuestion ───────────────────────────────────────────────────────
interface PendingQuestion {
  questions: Array<{ question: string; options: string[]; type?: string }>;
  resolve: (answer: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Pending AskUserQuestion: tool_use_id → { questions, resolve, timer }
const pendingQuestionState = new Map<string, PendingQuestion>();

function handleAskUserQuestion(toolCallId: string, questions: Array<{ question: string; options: string[]; type?: string }>): void {
  forwardEvent({ type: "tool_execution_start", toolName: "AskUserQuestion", toolCallId, args: { questions } });

  const timer = setTimeout(() => {
    pendingQuestionState.delete(toolCallId);
    pendingQuestions.delete(toolCallId);
    deliverAskUserAnswer(toolCallId, "");
  }, 5 * 60 * 1000);

  const pendingQ: PendingQuestion = {
    questions,
    resolve: (answer) => {
      clearTimeout(timer);
      pendingQuestionState.delete(toolCallId);
      pendingQuestions.delete(toolCallId);
      deliverAskUserAnswer(toolCallId, answer);
    },
    timer,
  };

  pendingQuestionState.set(toolCallId, pendingQ);
  pendingQuestions.set(toolCallId, { resolve: pendingQ.resolve, timer });

  emitHeartbeat("Waiting for answer…");
}

function deliverAskUserAnswer(toolCallId: string, answer: string): void {
  forwardEvent({ type: "tool_execution_end", toolName: "AskUserQuestion", toolCallId });
  writeToClaudeStdin({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolCallId, content: answer }],
    },
  });
  emitHeartbeat("Connected");
}

// ── session_active snapshot ───────────────────────────────────────────────
function emitSessionActive(): void {
  const sessionState: Record<string, unknown> = {
    model: currentModel,
    messages: capOversizedMessages(messages),
    cwd,
    sessionName: null,
    availableModels: [],
    todoList: [],
    thinkingLevel: null,
    workerType: "claude-code",
  };

  // Include pending prompts so they persist across reconnects
  if (pendingQuestionState.size > 0) {
    const [toolCallId, pendingQ] = [...pendingQuestionState.entries()][0];
    sessionState.pendingQuestion = {
      toolCallId,
      questions: pendingQ.questions,
      display: "modal",
    };
  }

  if (pendingPermissions.size > 0) {
    const [requestId, _entry] = [...pendingPermissions.entries()][0];
    sessionState.pendingPermission = { requestId };
  }

  if (needsChunkedDelivery(messages)) {
    const snapshotId = randomUUID();
    forwardEvent({ type: "session_active", state: { ...sessionState, messages: [], chunked: true, snapshotId, totalMessages: messages.length } });
    sendChunkedMessages(snapshotId);
  } else {
    forwardEvent({ type: "session_active", state: sessionState });
  }
}

function sendChunkedMessages(snapshotId: string): void {
  const capped = capOversizedMessages(messages);
  const chunks = computeChunkBoundaries(capped);
  let i = 0;
  function next() {
    if (i >= chunks.length) return;
    const [start, end] = chunks[i];
    const isFinal = i === chunks.length - 1;
    forwardEvent({ type: "session_messages_chunk", snapshotId, chunkIndex: i, totalChunks: chunks.length, totalMessages: capped.length, messages: capped.slice(start, end), final: isFinal });
    i++;
    if (i < chunks.length) setImmediate(next);
  }
  setImmediate(next);
}

// ── Relay connection ──────────────────────────────────────────────────────
function connectRelay(): void {
  if (!apiKey) {
    console.warn("[bridge] PIZZAPI_API_KEY not set — relay disabled");
    return;
  }

  const sockUrl = sioHttpUrl();
  const sock = io(sockUrl + "/relay", {
    auth: { apiKey },
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30_000,
    randomizationFactor: 0.25,
  }) as Socket<RelayServerToClientEvents, RelayClientToServerEvents>;

  sioSocket = sock;

  sock.on("connect", () => {
    sock.emit("register", {
      sessionId,
      cwd,
      ephemeral: true,
      collabMode: true,
      ...(parentSessionId ? { parentSessionId } : {}),
    });
  });

  sock.on("registered", (data) => {
    relayToken = data.token;
    emitHeartbeat("Starting Claude Code…");
    emitSessionActive();
  });

  sock.on("session_trigger" as any, (data: { trigger: ConversationTrigger }) => {
    const trigger = data?.trigger;
    if (!trigger) return;
    trackReceivedTrigger(trigger);
    writeToClaudeStdin({
      type: "user",
      message: { role: "user", content: renderTrigger(trigger) },
    });
  });

  sock.on("trigger_response" as any, (data: { triggerId: string; response: string; action?: string }) => {
    void respondToReceivedTrigger(data).catch((err) => {
      console.error("[bridge] failed to handle trigger response:", err);
    });
  });

  sock.on("input", (data) => {
    const text = data.text ?? "";

    // If a question is pending, deliver the input as the answer
    if (pendingQuestions.size > 0) {
      const [_toolCallId, entry] = [...pendingQuestions.entries()][0];
      entry.resolve(text);
      return;
    }

    // Normal user input → inject into claude stdin
    writeToClaudeStdin({
      type: "user",
      message: { role: "user", content: typeof data.text === "string" ? data.text : "" },
    });
  });

  // Handle incoming messages from other sessions
  // Delivers to waiting listeners or buffers for later retrieval (for pizzapi_check_messages)
  sock.on("session_message" as any, (data: { fromSessionId: string; message: string }) => {
    handleIncomingSessionMessage(data);
  });

  sock.on("exec", (data) => {
    const execData = data as { id: string; command: string; [key: string]: unknown };
    switch (execData.command) {
      case "abort":
        writeToClaudeStdin({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
        sock.emit("exec_result", { id: execData.id, ok: true, command: execData.command });
        break;
      case "end_session":
        sock.emit("exec_result", { id: execData.id, ok: true, command: execData.command });
        shutdown("completed");
        break;
      case "new_session":
        claudeSessionId = randomUUID();
        messages = [];
        currentModel = null;
        clearPendingState();
        processGeneration++;
        if (claudeProcess) { try { claudeProcess.kill("SIGTERM"); } catch {} claudeProcess = null; }
        setTimeout(() => { if (tmpDir) spawnClaude(tmpDir); }, 100);
        sock.emit("exec_result", { id: execData.id, ok: true, command: execData.command });
        break;
      case "reload":
        clearPendingState();
        processGeneration++;
        if (claudeProcess) { try { claudeProcess.kill("SIGTERM"); } catch {} claudeProcess = null; }
        setTimeout(() => { if (tmpDir) spawnClaude(tmpDir, true); }, 100);
        sock.emit("exec_result", { id: execData.id, ok: true, command: execData.command });
        break;
      case "permission_response":
        if (execData.requestId && execData.decision) {
          pendingPermissions.get(String(execData.requestId))?.resolve(execData.decision as "allow" | "deny");
        }
        sock.emit("exec_result", { id: execData.id, ok: true, command: execData.command });
        break;
      case "set_model":
        sock.emit("exec_result", { id: execData.id, ok: false, command: execData.command, error: "Model cannot be changed mid-session for Claude Code workers." });
        break;
      case "set_thinking_level":
      case "fork":
      case "navigate_tree":
      default:
        sock.emit("exec_result", { id: execData.id, ok: false, command: execData.command, error: "Not supported for Claude Code sessions." });
    }
  });

  sock.on("model_set", () => {
    forwardEvent({ type: "model_set_result", ok: false, message: "Model cannot be changed mid-session for Claude Code workers." });
  });

  sock.on("connected", () => {
    emitSessionActive();
  });

  sock.on("disconnect", () => {
    relayToken = null;
  });
}

// ── Shutdown ──────────────────────────────────────────────────────────────
let shutdownCalled = false;
async function shutdown(reason: "completed" | "error" | "killed" = "completed"): Promise<void> {
  if (shutdownCalled) return;
  shutdownCalled = true;

  clearPendingState();

  if (claudeProcess) {
    try { claudeProcess.kill("SIGTERM"); } catch {}
    claudeProcess = null;
  }

  if (sioSocket?.connected && relayToken) {
    sioSocket.emit("session_end", { sessionId, token: relayToken });
  }
  sioSocket?.disconnect();

  if (ipcServer) {
    ipcServer.close();
    ipcServer = null;
  }

  await cleanupTempDir();
  process.exit(reason === "error" ? 1 : 0);
}

process.on("SIGTERM", () => { void shutdown("killed"); });
process.on("SIGINT", () => { void shutdown("killed"); });

// ── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { ipcSocketPath, hooksPath: _hooksPath, mcpPath: _mcpPath } = await setupTempDir();
  await startIpcServer(ipcSocketPath);
  connectRelay();

  // PIZZAPI_CC_PLUGIN_DIR: the spec lists this as a daemon-provided env var, but
  // the bridge resolves it from import.meta.url instead — making it self-contained.
  // If overriding the plugin dir is needed (e.g. npm packaging), read
  // process.env.PIZZAPI_CC_PLUGIN_DIR first.
  setTimeout(() => { if (tmpDir) spawnClaude(tmpDir); }, 200);

  await new Promise<void>(() => {}); // keep process alive
}

main().catch((err) => {
  console.error("[bridge] fatal:", err);
  process.exit(1);
});

// Suppress unused variable warnings — broadcastToIpc will be used in future features
void broadcastToIpc;
