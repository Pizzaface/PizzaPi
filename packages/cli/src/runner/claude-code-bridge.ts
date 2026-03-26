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

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import type { Server as NetServer, Socket as NetSocket } from "node:net";
import { io, type Socket } from "socket.io-client";
import type { RelayClientToServerEvents, RelayServerToClientEvents } from "@pizzapi/protocol";
import { randomUUID } from "node:crypto";
import { translateNdjsonLine, SUBAGENT_TOOL_NAMES, parseSubagentToolCalls } from "./claude-code-ndjson.js";
import { serializeFrame, framesFromBuffer, type PluginMessage, type BridgeMessage } from "./claude-code-ipc.js";
import { SET_SESSION_NAME_PROMPT } from "../config/system-prompt.js";
import { buildSpawnSessionBody } from "./claude-code-spawn-request.js";
import { renderTrigger } from "../extensions/triggers/registry.js";
import type { ConversationTrigger } from "../extensions/triggers/types.js";
import { normalizeRemoteInputAttachments, buildUserMessageFromRemoteInput } from "../extensions/remote-input.js";
import {
  needsChunkedDelivery, capOversizedMessages, computeChunkBoundaries,
} from "../extensions/remote.js";
import { setLogComponent, setLogSessionId, logInfo, logWarn, logError } from "./logger.js";

const RELAY_DEFAULT = "ws://localhost:7492";

// ── Config from env ───────────────────────────────────────────────────────
const sessionId = process.env.PIZZAPI_SESSION_ID ?? randomUUID();
const cwd = process.env.PIZZAPI_WORKER_CWD ?? process.cwd();
const apiKey = process.env.PIZZAPI_API_KEY;
const relayUrl = (process.env.PIZZAPI_RELAY_URL ?? RELAY_DEFAULT).replace(/\/$/, "");
const parentSessionId = process.env.PIZZAPI_WORKER_PARENT_SESSION_ID ?? null;
let initialPrompt = process.env.PIZZAPI_WORKER_INITIAL_PROMPT ?? "";
const initialModelProvider = process.env.PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER?.trim() ?? "";
const initialModelId = process.env.PIZZAPI_WORKER_INITIAL_MODEL_ID?.trim() ?? "";

// ── Structured logging ────────────────────────────────────────────────────
// Use the shared logger so cc-bridge output interleaves cleanly with pi
// worker and daemon logs in runner.log / runner-error.log.
setLogComponent("cc-bridge");
setLogSessionId(sessionId);

/** When true, log every NDJSON event and relay forward at info level.
 *  Enable with PIZZAPI_CC_EVENT_LOG=1. Off by default to avoid log flood. */
const VERBOSE_EVENT_LOG = process.env.PIZZAPI_CC_EVENT_LOG === "1";

// Plugin dir: absolute path to the static plugin directory shipped with the CLI.
// The runner may execute from either src/runner/*.ts or dist/runner/*.js, but the
// plugin assets live under packages/cli/src/claude-code-plugin in this repo.
// Use fileURLToPath (not .pathname) to correctly handle Windows drive letters and
// URL-encoded characters (e.g. spaces) in the install path.
const PACKAGE_ROOT = resolvePath(fileURLToPath(new URL("../..", import.meta.url)));
const PLUGIN_DIR_CANDIDATES = [
  join(PACKAGE_ROOT, "src", "claude-code-plugin"),
  join(PACKAGE_ROOT, "claude-code-plugin"),
  // Packaged/npm installs: plugin dir lives next to the shipped binary or runner sidecar
  join(dirname(process.execPath), "claude-code-plugin"),
];
const PLUGIN_DIR: string = (() => {
  const found = PLUGIN_DIR_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Claude Code plugin directory not found. Looked in: ${PLUGIN_DIR_CANDIDATES.join(", ")}`);
  }
  return found;
})();

const IS_COMPILED_BINARY = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");
const BUN_RUNTIME = process.execPath && existsSync(process.execPath) ? process.execPath : "bun";

// Detect whether compiled (.js) plugin scripts exist alongside source (.ts).
const HOOK_HANDLER_JS = join(PLUGIN_DIR, "scripts", "hook-handler.js");
const MCP_SERVER_JS = join(PLUGIN_DIR, "scripts", "mcp-server.js");
const PLUGIN_SCRIPTS_COMPILED = existsSync(HOOK_HANDLER_JS) && existsSync(MCP_SERVER_JS);
const HOOK_HANDLER_SCRIPT = PLUGIN_SCRIPTS_COMPILED
  ? HOOK_HANDLER_JS
  : join(PLUGIN_DIR, "scripts", "hook-handler.ts");
const MCP_SERVER_SCRIPT = PLUGIN_SCRIPTS_COMPILED
  ? MCP_SERVER_JS
  : join(PLUGIN_DIR, "scripts", "mcp-server.ts");

function shellQuote(arg: string): string {
  // Escape backslashes first, then double-quotes, so a trailing backslash
  // or a `\"` sequence in the input cannot break out of the quoted string.
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function getHookHandlerCommand(ipcSocketPath: string): string {
  const args = IS_COMPILED_BINARY
    ? [process.execPath, "_claude_code_hook_handler", "--ipc", ipcSocketPath]
    : [BUN_RUNTIME, HOOK_HANDLER_SCRIPT, "--ipc", ipcSocketPath];
  return args.map(shellQuote).join(" ");
}

function getMcpServerCommand(): { command: string; args: string[] } {
  if (IS_COMPILED_BINARY) {
    return { command: process.execPath, args: ["_claude_code_mcp_server"] };
  }
  return { command: BUN_RUNTIME, args: [MCP_SERVER_SCRIPT] };
}

// ── State ─────────────────────────────────────────────────────────────────
let tmpDir: string | null = null;
let ipcSocketPath: string | null = null;
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

// ── Parity state (matches pi worker heartbeat/session_active contract) ────
const startTime = Date.now();
let currentSessionName: string | null = null;
let currentModelObject: { provider: string; id: string; name: string; reasoning?: boolean } | null = null;
let currentThinkingLevel: string | null = null;
let currentTokenUsage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; contextWindow?: number } | null = null;
let currentTodoList: unknown[] = [];
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// Pending AskUserQuestion: tool_use_id → { resolve, timer }
const pendingQuestions = new Map<string, { resolve: (answer: string) => void; timer: ReturnType<typeof setTimeout> }>();
// Pending tool executions: tool_use_id → { toolName, toolInput }
// Populated when tool_use blocks appear in assistant messages; consumed when
// tool_result blocks arrive in user messages. Used to emit synthetic
// tool_execution_start/end events and annotate toolResult messages.
const pendingToolCallMap = new Map<string, { toolName: string; toolInput: unknown }>();

// Subagent hook data: agent_id → metadata from SubagentStart/SubagentStop hooks.
// Claude Code fires these when the Task/Agent tool spawns or completes a subagent.
// We cache this data so we can enrich toolResult messages with subagent details.
interface SubagentHookInfo {
  agentId: string;
  subagentType?: string;
  description?: string;
  parentAgentId?: string;
  transcriptPath?: string;
  startedAt: number;
  stoppedAt?: number;
}
const subagentHookData = new Map<string, SubagentHookInfo>();
// Pending permission requests: requestId → pending handler metadata
interface PendingPermissionEntry {
  resolve: (decision: "allow" | "deny") => void;
  timer: ReturnType<typeof setTimeout>;
  toolName: string;
  toolInput: unknown;
  ts: number;
}
const pendingPermissions = new Map<string, PendingPermissionEntry>();
// Pending triggers this session has received from linked children.
const receivedTriggers = new Map<string, { sourceSessionId: string; type: string; trackedAt: number }>();
const TRIGGER_TTL_MS = 10 * 60 * 1000;
const IS_WINDOWS = process.platform === "win32";

// Buffered session messages from other sessions (for pizzapi_check_messages).
// Each entry: { fromSessionId, message }
const messageQueue: Array<{ fromSessionId: string; message: string }> = [];

// Pending message waiters: filters → resolver
// Allows pizzapi_wait_for_message to efficiently wait for matching messages
type MessageWaiter = {
  fromSessionIdFilter?: string;
  resolve: (msg: { fromSessionId: string; message: string }) => void;
  cancel: () => void;  // resolves outer Promise with null on teardown
  timer: ReturnType<typeof setTimeout>;
};
const messageWaiters: MessageWaiter[] = [];

// Generation counter — prevents stale watchClaudeExit from triggering shutdown
let processGeneration = 0;
let pendingRespawnTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingState(): void {
  claudeIsWorking = false;
  for (const { timer } of pendingQuestions.values()) clearTimeout(timer);
  pendingQuestions.clear();
  pendingQuestionState.clear();
  for (const { timer } of pendingPermissions.values()) clearTimeout(timer);
  pendingPermissions.clear();
  pendingAskUserPermissionQueue.length = 0;
  askUserPermissionByToolCallId.clear();
  for (const waiter of messageWaiters) {
    clearTimeout(waiter.timer);
    waiter.cancel();
  }
  messageWaiters.length = 0;
  pendingToolCallMap.clear();
  subagentHookData.clear();
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
  if (VERBOSE_EVENT_LOG) {
    const e = event as Record<string, unknown>;
    const parts = [`→relay seq=${seq + 1} type=${e.type ?? "?"}`];
    if (e.role) parts.push(`role=${e.role}`);
    if (e.toolName) parts.push(`tool=${e.toolName}`);
    if (e.toolCallId) parts.push(`callId=${(e.toolCallId as string).slice(0, 12)}`);
    // For message_update, peek inside the message for role/toolName
    if (e.type === "message_update" && e.message && typeof e.message === "object") {
      const m = e.message as Record<string, unknown>;
      if (m.role) parts.push(`msg.role=${m.role}`);
      if (m.toolName) parts.push(`msg.tool=${m.toolName}`);
      if (m.toolCallId) parts.push(`msg.callId=${(m.toolCallId as string).slice(0, 12)}`);
    }
    logInfo(parts.join(" "));
  }
  sioSocket.emit("event", { sessionId, token: relayToken, event, seq: ++seq });
}

function emitHeartbeat(status?: string): void {
  const hb: Record<string, unknown> = {
    type: "heartbeat",
    workerType: "claude-code",
    active: claudeIsWorking,
    isAgentActive: claudeIsWorking,
    model: currentModelObject ?? (currentModel ? parseModelString(currentModel) : null),
    sessionName: currentSessionName,
    ts: Date.now(),
    ...(status ? { status } : {}),
  };

  // Always include pendingQuestion so the UI's hasOwnProperty guard fires
  // and clears any stale prompt after resolution/timeout.
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
  } else {
    hb.pendingQuestion = null;
  }

  // Always include pendingPermission so the UI's hasOwnProperty guard fires
  // and clears any stale card after a timeout/resolution.
  if (pendingPermissions.size > 0) {
    const [requestId, entry] = [...pendingPermissions.entries()][0];
    hb.pendingPermission = {
      requestId,
      toolName: entry.toolName,
      toolInput: entry.toolInput,
      ts: entry.ts,
    };
  } else {
    hb.pendingPermission = null;
  }

  forwardEvent(hb);
}

// ── Capabilities ──────────────────────────────────────────────────────────
function emitCapabilities(): void {
  const { models } = listAvailableModels();
  forwardEvent({
    type: "capabilities",
    models,
    commands: [],
  });
}

// ── Heartbeat timer ───────────────────────────────────────────────────────
function startHeartbeatTimer(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    emitHeartbeat();
  }, 10_000);
}

function stopHeartbeatTimer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ── Model string parser ──────────────────────────────────────────────────
/** Strip Claude CLI model suffixes like `[1m]` (thinking budget indicators). */
function stripModelSuffix(modelStr: string): string {
  return modelStr.replace(/\[.*?\]$/, "").trim();
}

/** Parse a Claude model ID string into a structured model object.
 *  Looks up the well-known models list to find a clean display name.
 *  Falls back to a prettified version of the raw ID if not found.
 */
function parseModelString(modelStr: string): { provider: string; id: string; name: string; reasoning?: boolean } {
  const baseId = stripModelSuffix(modelStr);

  // Try to find a matching well-known model by exact ID or stripped ID
  const match = WELL_KNOWN_MODELS.find(
    (m) => m.id === baseId || m.id === modelStr,
  );

  if (match) {
    return {
      provider: match.provider,
      id: baseId,
      name: match.name,
      ...(match.reasoning ? { reasoning: true } : {}),
    };
  }

  // Fallback: prettify the raw model string (e.g. "claude-opus-4-6" → "Claude Opus 4 6")
  const prettyName = baseId
    .replace(/^claude-/, "Claude ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const reasoning = /opus|sonnet|claude-4|claude-3/.test(modelStr);

  return {
    provider: "anthropic",
    id: baseId,
    name: prettyName,
    ...(reasoning ? { reasoning: true } : {}),
  };
}

// ── Model list ────────────────────────────────────────────────────────────
/** Well-known models per provider — used to populate pizzapi_list_models. */
const WELL_KNOWN_MODELS: Array<{ provider: string; id: string; name: string; reasoning?: boolean }> = [
  // Anthropic
  { provider: "anthropic", id: "claude-opus-4-6",    name: "Claude Opus 4.6",   reasoning: true },
  { provider: "anthropic", id: "claude-sonnet-4-6",  name: "Claude Sonnet 4.6", reasoning: true },
  { provider: "anthropic", id: "claude-haiku-4-6",   name: "Claude Haiku 4.6" },
  { provider: "anthropic", id: "claude-opus-4-5",    name: "Claude Opus 4.5",   reasoning: true },
  { provider: "anthropic", id: "claude-sonnet-4-5",  name: "Claude Sonnet 4.5", reasoning: true },
  { provider: "anthropic", id: "claude-haiku-4-5",   name: "Claude Haiku 4.5" },
  { provider: "anthropic", id: "claude-opus-4",      name: "Claude Opus 4",     reasoning: true },
  { provider: "anthropic", id: "claude-sonnet-4",    name: "Claude Sonnet 4",   reasoning: true },
  { provider: "anthropic", id: "claude-haiku-4",     name: "Claude Haiku 4" },
  { provider: "anthropic", id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet", reasoning: true },
  { provider: "anthropic", id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
  { provider: "anthropic", id: "claude-3-5-haiku-20241022",  name: "Claude 3.5 Haiku" },
  // Google
  { provider: "google",    id: "gemini-2.5-pro",     name: "Gemini 2.5 Pro",   reasoning: true },
  { provider: "google",    id: "gemini-2.5-flash",   name: "Gemini 2.5 Flash", reasoning: true },
  { provider: "google",    id: "gemini-2.0-flash",   name: "Gemini 2.0 Flash" },
  // OpenAI
  { provider: "openai",    id: "o3",                 name: "o3",               reasoning: true },
  { provider: "openai",    id: "o4-mini",            name: "o4-mini",          reasoning: true },
  { provider: "openai",    id: "gpt-4.1",            name: "GPT-4.1" },
  { provider: "openai",    id: "gpt-4o",             name: "GPT-4o" },
];

/**
 * Return models available on this runner.
 * Reads ~/.pizzapi/auth.json (or $PIZZAPI_AGENT_DIR/auth.json) to discover
 * which providers have credentials, then filters the well-known model list to
 * those providers.  Always includes the current session model as a fallback.
 */
// Auth.json key → canonical provider name used in WELL_KNOWN_MODELS.
// The CLI stores credentials under provider-specific keys that don't match
// the shorter names used in the model list (e.g. "google-gemini-cli" → "google").
const AUTH_PROVIDER_MAP: Record<string, string> = {
  "google-gemini-cli": "google",
  "openai-codex": "openai",
};

function listAvailableModels(): { models: Array<{ provider: string; id: string; name: string; reasoning?: boolean }> } {
  // Detect which providers have credentials
  const agentDir = process.env.PIZZAPI_AGENT_DIR ?? join(homedir(), ".pizzapi");
  let configuredProviders = new Set<string>();
  try {
    const raw = readFileSync(join(agentDir, "auth.json"), "utf-8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    // Normalize auth.json keys to canonical provider names used in WELL_KNOWN_MODELS.
    configuredProviders = new Set(
      Object.keys(auth).map((k) => AUTH_PROVIDER_MAP[k] ?? k),
    );
  } catch {
    // auth.json missing or unreadable — fall back to current model only
  }

  // If we can read credentials, filter to configured providers; otherwise return all models
  // (so the tool is still useful even if auth.json is temporarily unavailable).
  let models = configuredProviders.size > 0
    ? WELL_KNOWN_MODELS.filter((m) => configuredProviders.has(m.provider))
    : [...WELL_KNOWN_MODELS];

  // Always include the current session model so the list is never empty.
  if (
    currentModelObject &&
    !models.some((m) => m.provider === currentModelObject!.provider && m.id === currentModelObject!.id)
  ) {
    models.unshift(currentModelObject);
  }

  // Apply hidden-model filter from the environment (set by daemon via PIZZAPI_HIDDEN_MODELS).
  const hiddenRaw = process.env.PIZZAPI_HIDDEN_MODELS;
  if (hiddenRaw) {
    try {
      const hidden = JSON.parse(hiddenRaw) as unknown;
      if (Array.isArray(hidden) && hidden.length > 0) {
        const hiddenKeys = new Set(hidden.filter((h): h is string => typeof h === "string"));
        models = models.filter((m) => !hiddenKeys.has(`${m.provider}/${m.id}`));
      }
    } catch {
      // Malformed PIZZAPI_HIDDEN_MODELS — ignore
    }
  }

  return { models };
}

// ── Temp dir and config file generation ──────────────────────────────────
async function setupTempDir(): Promise<{ ipcSocketPath: string; hooksPath: string; mcpPath: string }> {
  tmpDir = await mkdtemp(join(tmpdir(), "pizzapi-cc-"));
  await chmod(tmpDir, 0o700);

  // Compute the IPC path once and store it in the module-level variable so
  // spawnClaude() can reuse the exact same path.  Always re-deriving it with
  // join(tmpDir, "bridge.sock") would silently produce the wrong path on
  // Windows, where a named pipe is required instead of a filesystem socket.
  const resolvedIpcPath = IS_WINDOWS
    ? `\\\\.\\pipe\\pizzapi-cc-${randomUUID()}`
    : join(tmpDir, "bridge.sock");
  ipcSocketPath = resolvedIpcPath;

  const hooksJson = {
    hooks: Object.fromEntries(
      ["SessionStart","SessionEnd","PostToolUse","PostToolUseFailure",
       "Stop","SubagentStart","SubagentStop","Notification","UserPromptSubmit","PreCompact"].map(
        (evt) => [evt, [{ hooks: [{ type: "command", command: getHookHandlerCommand(resolvedIpcPath) }] }]]
      )
    ),
  };
  const hooksPath = join(tmpDir, "hooks.json");
  await writeFile(hooksPath, JSON.stringify(hooksJson, null, 2), { mode: 0o600 });

  const mcpServerCommand = getMcpServerCommand();
  const mcpJson = {
    mcpServers: {
      pizzapi: {
        command: mcpServerCommand.command,
        args: mcpServerCommand.args,
        env: {
          PIZZAPI_CC_BRIDGE_IPC: resolvedIpcPath,
          PIZZAPI_SESSION_ID: sessionId,
        },
      },
    },
  };
  const mcpPath = join(tmpDir, "mcp.json");
  await writeFile(mcpPath, JSON.stringify(mcpJson, null, 2), { mode: 0o600 });

  return { ipcSocketPath: resolvedIpcPath, hooksPath, mcpPath };
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
    // Extract enriched data from SubagentStart/SubagentStop hook events.
    // Claude Code fires these when the Task/Agent tool spawns or completes
    // a subagent. The hook input (msg.data) carries agent details that we
    // can use to provide richer UI rendering.
    if (msg.event === "SubagentStart" || msg.event === "SubagentStop") {
      const hookData = msg.data as Record<string, unknown> | undefined;
      if (hookData) {
        // Store subagent metadata keyed by agent_id so we can attach it
        // to the tool_result when SubagentStop fires later.
        const agentId = typeof hookData.agent_id === "string" ? hookData.agent_id : undefined;
        const subagentType = typeof hookData.subagent_type === "string" ? hookData.subagent_type : undefined;
        const parentAgentId = typeof hookData.parent_agent_id === "string" ? hookData.parent_agent_id : undefined;
        logInfo(`hook: ${msg.event} agent=${agentId ?? "?"} type=${subagentType ?? "?"} parent=${parentAgentId ?? "?"}`);
        if (msg.event === "SubagentStart" && agentId) {
          subagentHookData.set(agentId, {
            agentId,
            subagentType,
            description: typeof hookData.description === "string" ? hookData.description : undefined,
            parentAgentId,
            startedAt: Date.now(),
          });
        }
        if (msg.event === "SubagentStop" && agentId) {
          const startData = subagentHookData.get(agentId);
          if (startData) {
            startData.stoppedAt = Date.now();
            startData.transcriptPath = typeof hookData.transcript_path === "string" ? hookData.transcript_path : undefined;
          }
        }
      }
    }
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
    case "set_session_name": {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (name) {
        currentSessionName = name;
        // Broadcast immediately so the server updates the session name without
        // waiting for the next scheduled heartbeat.
        emitHeartbeat();
      }
      return "ok";
    }

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
      const requestedTimeout = Number(args.timeout ?? 20_000);
      const normalizedTimeout = Number.isFinite(requestedTimeout) ? requestedTimeout : 20_000;
      const timeoutMs = Math.min(Math.max(normalizedTimeout, 0), 25_000);
      return new Promise<unknown>((resolve) => {
        // First check if there's an already-buffered message that matches
        const fromSessionIdFilter = typeof args.fromSessionId === "string" ? args.fromSessionId : undefined;
        let foundIdx = -1;

        if (!fromSessionIdFilter) {
          // Only consume index 0 if the queue actually has an entry; an empty
          // queue leaves foundIdx at -1 so we fall through to the waiter path.
          foundIdx = messageQueue.length > 0 ? 0 : -1;
        } else {
          foundIdx = messageQueue.findIndex((m) => m.fromSessionId === fromSessionIdFilter);
        }

        if (foundIdx >= 0) {
          const msg = messageQueue.splice(foundIdx, 1)[0];
          resolve({ fromSessionId: msg.fromSessionId, message: msg.message });
          return;
        }

        if (timeoutMs === 0) {
          resolve(null);
          return;
        }

        const deadlineAt = Date.now() + timeoutMs;
        const waiter: MessageWaiter = {
          fromSessionIdFilter,
          resolve: (msg) => resolve({ fromSessionId: msg.fromSessionId, message: msg.message }),
          cancel: () => resolve(null),
          timer: null as unknown as ReturnType<typeof setTimeout>,
        };

        const pollForTimeout = () => {
          if (!messageWaiters.includes(waiter)) return;
          if (Date.now() >= deadlineAt) {
            const idx = messageWaiters.indexOf(waiter);
            if (idx >= 0) messageWaiters.splice(idx, 1);
            resolve(null);
            return;
          }
          waiter.timer = setTimeout(pollForTimeout, 100);
        };

        waiter.timer = setTimeout(pollForTimeout, 100);
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
      return listAvailableModels();

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
  receivedTriggers.delete(triggerId);
}

// ── Claude subprocess ─────────────────────────────────────────────────────
function spawnClaude(tmpDirPath: string, resume = false): void {
  logInfo(`spawning claude (resume=${resume}, generation=${processGeneration + 1}, cwd=${cwd})`);
  _stdoutBuf = "";  // reset on every spawn
  _stdoutDecoder = new TextDecoder();  // clear stale multi-byte state
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
    // Instruct Claude to call set_session_name at the start of each new
    // conversation so PizzaPi can display a meaningful session title.
    // Skipped on --resume because the session already has a name from its
    // first turn (the conversation history already contains the first
    // set_session_name call), so re-injecting the instruction is unnecessary
    // noise and could cause a spurious rename.
    ...(!resume ? ["--append-system-prompt", SET_SESSION_NAME_PROMPT] : []),
    ...(initialModelId
      ? initialModelProvider && initialModelProvider !== "anthropic"
        ? []
        : ["--model", initialModelId]
      : []),
    ...(resume ? ["--resume", claudeSessionId] : []),
  ];

  if (initialModelId && initialModelProvider && initialModelProvider !== "anthropic") {
    logWarn(`ignoring unsupported initial model provider for Claude Code worker: ${initialModelProvider}`);
  }

  const command = resume
    ? ["claude", "-p", ...cliArgs]
    : ["claude", "-p", initialPrompt, ...cliArgs];

  claudeProcess = Bun.spawn(command, {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Use the pre-computed ipcSocketPath (set by setupTempDir) so Windows
      // named pipe paths are preserved.  Falling back to a Unix socket path
      // constructed from tmpDirPath would break on Windows.
      PIZZAPI_CC_BRIDGE_IPC: ipcSocketPath ?? join(tmpDirPath, "bridge.sock"),
      PIZZAPI_SESSION_ID: sessionId,
    },
  });

  void readClaudeStdout(myGeneration);
  void readClaudeStderr();
  void watchClaudeExit(tmpDirPath, myGeneration);
}

function writeToClaudeStdin(msg: unknown): void {
  if (!claudeProcess?.stdin) return;
  const data = JSON.stringify(msg) + "\n";
  (claudeProcess.stdin as any).write(data);
}

let _stdoutDecoder = new TextDecoder();
const _stderrDecoder = new TextDecoder();
let _stdoutBuf = "";

async function readClaudeStdout(generation: number): Promise<void> {
  if (!claudeProcess?.stdout) return;
  // Bun subprocess stdout is a ReadableStream — use async iteration
  for await (const chunk of claudeProcess.stdout as AsyncIterable<Uint8Array>) {
    if (generation !== processGeneration) return; // stale process — drop
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
    if (text.trim()) logWarn(`[claude stderr] ${text.trimEnd()}`);
  }
}

async function watchClaudeExit(tmpDirPath: string, generation: number): Promise<void> {
  if (!claudeProcess) return;
  const exitCode = await claudeProcess.exited;
  claudeProcess = null;

  // If a newer process has been spawned since, this watcher is stale
  if (generation !== processGeneration) {
    logInfo(`stale exit watcher (generation=${generation}, current=${processGeneration}) — ignoring exit code ${exitCode}`);
    return;
  }

  if (exitCode === 43) {
    logInfo("claude exited with code 43 — restarting with --resume");
    spawnClaude(tmpDirPath, true);
    return;
  }

  logInfo(`claude exited with code ${exitCode} — shutting down (${exitCode === 0 ? "completed" : "error"})`);
  shutdown(exitCode === 0 ? "completed" : "error");
}

// ── Subagent details synthesis ─────────────────────────────────────────────
/**
 * Synthesize a pi-style SubagentDetails object from Claude Code's Task/Agent
 * tool input and result content. This allows the SubagentResultCard to render
 * structured results (agent name, task, usage) instead of just plain text.
 *
 * The resulting object matches the shape expected by SubagentResultCard:
 *   { mode, agentScope, projectAgentsDir, results: [{ agent, task, exitCode, messages, usage, ... }] }
 */
function synthesizeSubagentDetails(toolName: string, toolInput: unknown, resultContent: unknown): Record<string, unknown> {
  const input = toolInput && typeof toolInput === "object" ? toolInput as Record<string, unknown> : {};

  // Extract agent info from tool input (Claude Code Task/Agent schema)
  const agentName = typeof input.subagent_type === "string" ? input.subagent_type
    : typeof input.agent === "string" ? input.agent
    : "agent";
  const task = typeof input.prompt === "string" ? input.prompt
    : typeof input.task === "string" ? input.task
    : typeof input.description === "string" ? input.description
    : "";

  // Extract the text result from content
  let resultText = "";
  if (typeof resultContent === "string") {
    resultText = resultContent;
  } else if (Array.isArray(resultContent)) {
    for (const block of resultContent) {
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
        resultText += (resultText ? "\n" : "") + String((block as Record<string, unknown>).text ?? "");
      }
    }
  }

  // Build a SingleResult-compatible object
  const singleResult: Record<string, unknown> = {
    agent: agentName,
    agentSource: "user",
    task,
    exitCode: 0,
    // Provide a minimal messages array with the final assistant response
    messages: resultText ? parseSubagentToolCalls(resultText) : [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };

  // Try to find matching hook data for richer metadata
  // (SubagentStart/SubagentStop hooks carry agent_id, duration, etc.)
  for (const [, hookInfo] of subagentHookData) {
    if (hookInfo.subagentType === agentName || hookInfo.description === (input.description as string)) {
      if (hookInfo.stoppedAt && hookInfo.startedAt) {
        // Can't directly set usage.durationMs but it's useful context
        singleResult.model = hookInfo.subagentType;
      }
      // Clean up consumed hook data
      subagentHookData.delete(hookInfo.agentId);
      break;
    }
  }

  return {
    mode: "single",
    agentScope: "user",
    projectAgentsDir: null,
    results: [singleResult],
  };
}

// ── NDJSON event handling ─────────────────────────────────────────────────
function handleNdjsonLine(line: string): void {
  const result = translateNdjsonLine(line);

  if (VERBOSE_EVENT_LOG) {
    const parts = [`←ndjson kind=${result.kind}`];
    if (result.toolName) parts.push(`tool=${result.toolName}`);
    if (result.toolCallId) parts.push(`callId=${result.toolCallId.slice(0, 12)}`);
    if (result.sessionId) parts.push(`ccSessionId=${result.sessionId}`);
    if (result.model) parts.push(`model=${result.model}`);
    if (result.sessionName) parts.push(`name="${result.sessionName}"`);
    if (result.toolCalls?.length) {
      const tcSummary = result.toolCalls.map(tc => tc.toolName).join(",");
      parts.push(`toolCalls=[${tcSummary}]`);
    }
    if (result.relayEvent) {
      const e = result.relayEvent as Record<string, unknown>;
      parts.push(`event.type=${e.type ?? "?"}`);
      if (e.role) parts.push(`event.role=${e.role}`);
      const m = e.message as Record<string, unknown> | undefined;
      if (m?.role) parts.push(`msg.role=${m.role}`);
      if (m?.toolName) parts.push(`msg.tool=${m.toolName}`);
    }
    if (result.relayEvents?.length) {
      const roles = result.relayEvents.map(e => {
        const m = (e as Record<string, unknown>).message as Record<string, unknown> | undefined;
        return m?.role ?? (e as Record<string, unknown>).type ?? "?";
      });
      parts.push(`events=[${roles.join(",")}]`);
    }
    logInfo(parts.join(" "));
  }

  if (result.kind === "control_request") {
    // Suppress permission/control requests that originate inside a subagent.
    // These should never surface as top-level permission prompts in the parent session.
    if (result.parentToolUseId) {
      if (VERBOSE_EVENT_LOG) {
        logInfo(`suppressed subagent control_request (parent=${result.parentToolUseId.slice(0, 12)})`);
      }
      return;
    }
    if (result.controlRequestId && result.toolName) {
      handleControlRequest(result.controlRequestId, result.toolName, result.toolInput);
    }
    return;
  }

  if (result.kind === "session_init") {
    logInfo(`session_init: ccSessionId=${result.sessionId ?? "?"} model=${result.model ?? "?"}`);
    if (result.sessionId) claudeSessionId = result.sessionId;
    if (result.model) {
      currentModel = result.model;
      currentModelObject = parseModelString(result.model);
    }
    claudeIsWorking = false;
    emitCapabilities();
    emitSessionActive();
    return;
  }

  if (result.kind === "ask_user_question") {
    // Suppress AskUserQuestion calls that originate inside a subagent.
    // Subagent questions must not create pending question state in the parent session.
    if (result.parentToolUseId) {
      if (VERBOSE_EVENT_LOG) {
        logInfo(`suppressed subagent ask_user_question (parent=${result.parentToolUseId.slice(0, 12)})`);
      }
      return;
    }
    // Forward the assistant message to history first so reconnecting viewers
    // see the full conversation including the AskUserQuestion turn.
    if (result.relayEvent?.message) {
      messages.push(result.relayEvent.message);
      claudeIsWorking = true;
      forwardEvent(result.relayEvent);
    }
    if (result.toolCallId) {
      handleAskUserQuestion(result.toolCallId, result.questions ?? []);
    }
    return;
  }

  if (result.kind === "relay_event" && (result.relayEvent || result.relayEvents)) {
    // ── Suppress subagent-internal events early ──────────────────────
    // Claude Code sets `parent_tool_use_id` on every NDJSON message.
    // When non-null, the event belongs to a subagent (Agent/Task tool)
    // and should not appear in the parent conversation.  The subagent's
    // final result is delivered as a toolResult matching the parent's
    // toolCallId, which has `parent_tool_use_id: null` — so it passes
    // through normally.
    // IMPORTANT: this guard must come BEFORE any side-effect application
    // (todoList, sessionName, tokenUsage) to prevent subagent state from
    // corrupting the parent session.
    if (result.parentToolUseId) {
      if (VERBOSE_EVENT_LOG) {
        logInfo(`suppressed subagent-internal (parent=${result.parentToolUseId.slice(0, 12)})`);
      }
      return;
    }

    // Update parity state from side-effects carried on the translation result
    if (result.todoList) {
      currentTodoList = result.todoList;
      forwardEvent({ type: "todo_update", todos: result.todoList, ts: Date.now() });
    }
    if (result.sessionName !== undefined) {
      currentSessionName = result.sessionName;
      // Emit an immediate heartbeat so the relay picks up the new name without
      // waiting for the next scheduled 10-second heartbeat.
      emitHeartbeat();
    }
    if (result.tokenUsage) {
      currentTokenUsage = result.tokenUsage;
    }

    // ── Emit synthetic tool_execution_start events ────────────────────
    // When an assistant message contains tool_use blocks, emit start events
    // so the UI can track active tool calls (spinning indicators).
    if (result.toolCalls) {
      for (const tc of result.toolCalls) {
        pendingToolCallMap.set(tc.toolCallId, { toolName: tc.toolName, toolInput: tc.toolInput });
        forwardEvent({
          type: "tool_execution_start",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.toolInput,
        });
      }
    }

    // Support both single (relayEvent) and multiple (relayEvents) events.
    // relayEvents is used when one NDJSON line produces multiple relay events
    // (e.g. a user message containing several tool_result blocks).
    const events = result.relayEvents ?? (result.relayEvent ? [result.relayEvent] : []);

    // First pass: annotate toolResult messages with toolName from the
    // pending tool call, and collect tool_execution_end events to emit.
    const toolEndEvents: Array<{ toolCallId: string; toolName: string; isError: boolean }> = [];

    for (const relayEvent of events) {
      if (relayEvent.type !== "message_update") continue;
      const msg = relayEvent.message as Record<string, unknown> | undefined;
      if (!msg || msg.role !== "toolResult") continue;

      const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
      if (!toolCallId) continue;

      const pending = pendingToolCallMap.get(toolCallId);
      if (!pending) continue;

      // Annotate with toolName so the UI's rendering pipeline can select the
      // correct card component (e.g. SubagentResultCard for "subagent").
      if (!msg.toolName) {
        msg.toolName = pending.toolName;
      }

      // For subagent tools (Task/Agent/subagent), synthesize a pi-style
      // `details` object so the SubagentResultCard can render structured
      // results instead of falling back to plain text.
      if (SUBAGENT_TOOL_NAMES.has(pending.toolName) && !msg.details) {
        msg.details = synthesizeSubagentDetails(pending.toolName, pending.toolInput, msg.content);
      }

      // Queue a synthetic tool_execution_end event
      toolEndEvents.push({
        toolCallId,
        toolName: pending.toolName,
        isError: msg.isError === true,
      });
      pendingToolCallMap.delete(toolCallId);
    }

    // Emit tool_execution_end events BEFORE forwarding the relay messages,
    // matching the pi-native event order (end event clears activeToolCalls
    // in the UI, then the message_update adds the final tool result).
    for (const endEvt of toolEndEvents) {
      forwardEvent({
        type: "tool_execution_end",
        toolCallId: endEvt.toolCallId,
        toolName: endEvt.toolName,
        result: null,
        isError: endEvt.isError,
      });
    }

    // Second pass: forward relay events and update bridge state.
    for (const relayEvent of events) {
      const eventType = relayEvent.type;
      if (eventType === "message_update") {
        if (relayEvent.message) {
          messages.push(relayEvent.message);
        }
        claudeIsWorking = true;  // Claude is actively working/outputting
      } else if (eventType === "agent_end" || eventType === "turn_end") {
        claudeIsWorking = false;  // Turn complete, Claude is now idle
      }
      forwardEvent(relayEvent);
    }
  }
}

// ── Permission request via control protocol ───────────────────────────────
/** Tools that should be auto-allowed without showing a permission request card.
 *  - ToolSearch: harmless internal tool for discovering available tools
 *  - EnterPlanMode: just enters read-only exploration mode (no side effects) */
const AUTO_ALLOW_TOOLS = new Set(["ToolSearch", "EnterPlanMode"]);

/** Check whether a tool should be auto-allowed.
 *  Matches exact names in AUTO_ALLOW_TOOLS and all PizzaPi MCP tools. */
function shouldAutoAllow(toolName: string): boolean {
  if (AUTO_ALLOW_TOOLS.has(toolName)) return true;
  // Auto-allow all PizzaPi MCP tools — they're our own trusted tools
  if (toolName.startsWith("mcp__pizzapi__")) return true;
  return false;
}

// Pending AskUserQuestion permissions: queue of unmatched controlRequestIds waiting
// to be paired with a toolCallId once the ask_user_question event arrives.
// Using a queue (FIFO) + per-toolCallId map handles multiple concurrent requests
// correctly without overwriting earlier IDs.
const pendingAskUserPermissionQueue: string[] = [];
// toolCallId → controlRequestId, populated when ask_user_question is processed
const askUserPermissionByToolCallId = new Map<string, string>();

function handleControlRequest(requestId: string, toolName: string, toolInput: unknown): void {
  // Auto-allow safe internal tools — no permission card needed
  if (shouldAutoAllow(toolName)) {
    sendPermissionResponse(requestId, "allow", toolInput);
    return;
  }

  // AskUserQuestion: enqueue the permission request ID.  It will be matched to
  // a toolCallId when the corresponding ask_user_question event is processed.
  // Using a queue preserves ordering and supports multiple concurrent requests.
  if (toolName === "AskUserQuestion") {
    pendingAskUserPermissionQueue.push(requestId);
    return;
  }

  const requestTs = Date.now();
  forwardEvent({
    type: "permission_request",
    requestId,
    toolName,
    toolInput,
    ts: requestTs,
  });

  const timer = setTimeout(() => {
    pendingPermissions.delete(requestId);
    sendPermissionResponse(requestId, "deny");
    emitHeartbeat();
  }, 5 * 60 * 1000);

  const pendingPermissionEntry: PendingPermissionEntry = {
    resolve: (decision) => {
      clearTimeout(timer);
      pendingPermissions.delete(requestId);
      sendPermissionResponse(requestId, decision, toolInput);
      emitHeartbeat();
    },
    timer,
    toolName,
    toolInput,
    ts: requestTs,
  };
  pendingPermissions.set(requestId, pendingPermissionEntry);
  emitHeartbeat("Waiting for permission…");
  emitSessionActive();
}

function sendPermissionResponse(requestId: string, behavior: "allow" | "deny", toolInput?: unknown): void {
  writeToClaudeStdin({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: behavior === "allow"
        ? { behavior: "allow", updatedInput: (toolInput && typeof toolInput === "object" ? toolInput : {}) as Record<string, unknown> }
        : { behavior: "deny", message: "Denied via PizzaPi web UI" },
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

  // Pair this toolCallId with the next queued permission request ID (FIFO order
  // matches the order in which control_request events arrive).
  const permId = pendingAskUserPermissionQueue.shift();
  if (permId) {
    askUserPermissionByToolCallId.set(toolCallId, permId);
  }

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

  // Unblock Claude Code by responding to the held permission request.
  // Must happen BEFORE the tool_result so Claude Code is ready to receive it.
  const permId = askUserPermissionByToolCallId.get(toolCallId);
  if (permId) {
    sendPermissionResponse(permId, "allow");
    askUserPermissionByToolCallId.delete(toolCallId);
  }

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
    model: currentModelObject ?? (currentModel ? parseModelString(currentModel) : null),
    messages: capOversizedMessages(messages),
    cwd,
    sessionName: currentSessionName,
    availableModels: listAvailableModels().models,
    todoList: currentTodoList,
    thinkingLevel: currentThinkingLevel,
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
    const [requestId, entry] = [...pendingPermissions.entries()][0];
    sessionState.pendingPermission = {
      requestId,
      toolName: entry.toolName,
      toolInput: entry.toolInput,
      ts: entry.ts,
    };
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
    logWarn("PIZZAPI_API_KEY not set — relay disabled");
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
    logInfo(`relay connected (url=${sockUrl})`);
    sock.emit("register", {
      sessionId,
      cwd,
      ephemeral: true,
      collabMode: true,
      ...(parentSessionId ? { parentSessionId } : {}),
    });
  });

  sock.on("registered", (data) => {
    logInfo("relay registered");
    relayToken = data.token;
    emitCapabilities();
    emitHeartbeat("Starting Claude Code…");
    emitSessionActive();
    startHeartbeatTimer();
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
      logError(`failed to handle trigger response: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  sock.on("input", (data) => {
    const text = typeof data.text === "string" ? data.text : "";

    // If a question is pending, deliver the input as the answer
    if (pendingQuestions.size > 0) {
      const [_toolCallId, entry] = [...pendingQuestions.entries()][0];
      entry.resolve(text);
      return;
    }

    const attachments = normalizeRemoteInputAttachments(data.attachments);
    void (async () => {
      try {
        const content = await buildUserMessageFromRemoteInput(
          text,
          attachments,
          relayHttpBase(),
          apiKey ?? "",
          claudeSessionId,
        );
        writeToClaudeStdin({
          type: "user",
          message: { role: "user", content },
        });
      } catch (err) {
        logError(`failed to deliver input: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
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
        logInfo("exec: end_session");
        sock.emit("exec_result", { id: execData.id, ok: true, command: execData.command });
        shutdown("completed");
        break;
      case "new_session":
        logInfo("exec: new_session — killing claude, clearing state, respawning");
        claudeSessionId = randomUUID();
        initialPrompt = "";
        messages = [];
        currentModel = null;
        currentModelObject = null;
        currentSessionName = null;
        currentTokenUsage = null;
        currentTodoList = [];
        clearPendingState();
        processGeneration++;
        if (claudeProcess) { try { claudeProcess.kill("SIGTERM"); } catch {} claudeProcess = null; }
        if (pendingRespawnTimer) { clearTimeout(pendingRespawnTimer); pendingRespawnTimer = null; }
        pendingRespawnTimer = setTimeout(() => { pendingRespawnTimer = null; if (tmpDir) spawnClaude(tmpDir); }, 100);
        sock.emit("exec_result", { id: execData.id, ok: true, command: execData.command });
        break;
      case "reload":
        logInfo("exec: reload — killing claude, respawning with --resume");
        clearPendingState();
        processGeneration++;
        if (claudeProcess) { try { claudeProcess.kill("SIGTERM"); } catch {} claudeProcess = null; }
        if (pendingRespawnTimer) { clearTimeout(pendingRespawnTimer); pendingRespawnTimer = null; }
        pendingRespawnTimer = setTimeout(() => { pendingRespawnTimer = null; if (tmpDir) spawnClaude(tmpDir, true); }, 100);
        sock.emit("exec_result", { id: execData.id, ok: true, command: execData.command });
        break;
      case "permission_response":
        if (execData.requestId && execData.decision) {
          pendingPermissions.get(String(execData.requestId))?.resolve(execData.decision as "allow" | "deny");
        }
        sock.emit("exec_result", { id: execData.id, ok: true, command: execData.command });
        break;
      case "set_model": {
        // Use Claude Code's control protocol to change model mid-session.
        const modelId = typeof execData.modelId === "string" ? execData.modelId : undefined;
        if (!modelId) {
          sock.emit("exec_result", { id: execData.id, ok: false, command: execData.command, error: "Missing modelId." });
          break;
        }
        logInfo(`exec: set_model model=${modelId}`);
        writeToClaudeStdin({
          type: "control_request",
          request_id: randomUUID(),
          request: { subtype: "set_model", model: modelId },
        });
        // Update our tracking — the actual confirmation comes from Claude's
        // next system/init or assistant message with the new model.
        currentModel = modelId;
        currentModelObject = parseModelString(modelId);
        emitHeartbeat();
        sock.emit("exec_result", { id: execData.id, ok: true, command: execData.command });
        forwardEvent({ type: "model_set_result", ok: true, provider: currentModelObject?.provider, modelId });
        break;
      }
      case "set_thinking_level": {
        // Use Claude Code's control protocol to change thinking budget.
        const level = typeof execData.level === "string" ? execData.level : undefined;
        // Map PizzaPi thinking levels to token counts.
        // null = default (let Claude decide), 0 = off, positive = budget.
        const tokenMap: Record<string, number | null> = {
          off: 0, low: 1024, medium: 8192, high: 32768, max: 128000,
        };
        const tokens = level && level in tokenMap ? tokenMap[level] : undefined;
        if (tokens === undefined) {
          sock.emit("exec_result", { id: execData.id, ok: false, command: execData.command, error: `Unknown thinking level: ${level}` });
          break;
        }
        logInfo(`exec: set_thinking_level level=${level} tokens=${tokens}`);
        writeToClaudeStdin({
          type: "control_request",
          request_id: randomUUID(),
          request: { subtype: "set_max_thinking_tokens", max_thinking_tokens: tokens === 0 ? null : tokens },
        });
        currentThinkingLevel = level ?? null;
        emitHeartbeat();
        sock.emit("exec_result", { id: execData.id, ok: true, command: execData.command });
        break;
      }
      case "fork":
      case "navigate_tree":
      default:
        sock.emit("exec_result", { id: execData.id, ok: false, command: execData.command, error: "Not supported for Claude Code sessions." });
    }
  });

  sock.on("model_set", (data) => {
    // Legacy model_set event from older UI — route through set_model control protocol
    const modelId = typeof data?.modelId === "string" ? data.modelId : undefined;
    if (!modelId) {
      forwardEvent({ type: "model_set_result", ok: false, message: "Missing modelId." });
      return;
    }
    logInfo(`model_set (legacy): model=${modelId}`);
    writeToClaudeStdin({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_model", model: modelId },
    });
    currentModel = modelId;
    currentModelObject = parseModelString(modelId);
    emitHeartbeat();
    forwardEvent({ type: "model_set_result", ok: true, provider: currentModelObject?.provider, modelId });
  });

  sock.on("connected", () => {
    emitSessionActive();
  });

  sock.on("disconnect", (reason) => {
    logInfo(`relay disconnected: ${reason}`);
    relayToken = null;
    stopHeartbeatTimer();
  });
}

// ── Shutdown ──────────────────────────────────────────────────────────────
let shutdownCalled = false;
async function shutdown(reason: "completed" | "error" | "killed" = "completed"): Promise<void> {
  if (shutdownCalled) return;
  shutdownCalled = true;
  logInfo(`shutdown: reason=${reason}`);

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
  logInfo(`started (cwd=${cwd}, parent=${parentSessionId ?? "none"}, verbose=${VERBOSE_EVENT_LOG})`);

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
  logError(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});

// Suppress unused variable warnings — broadcastToIpc will be used in future features
void broadcastToIpc;
