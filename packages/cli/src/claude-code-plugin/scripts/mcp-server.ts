#!/usr/bin/env bun
/**
 * PizzaPi MCP server — provides inter-session tools to Claude Code sessions.
 * Runs as a stdio MCP server; Claude Code spawns it from the generated mcp.json.
 * Forwards all tool calls to the bridge via Unix IPC socket.
 *
 * NOTE: We register tools via the low-level Server API to avoid TS2589
 * "excessively deep type instantiation" from the McpServer + Zod generics.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import {
  serializeFrame,
  framesFromBuffer,
  type PluginMessage,
  type BridgeMessage,
} from "../../runner/claude-code-ipc.js";

const ipcPath = process.env.PIZZAPI_CC_BRIDGE_IPC;
const sessionId = process.env.PIZZAPI_SESSION_ID ?? "unknown";

if (!ipcPath) {
  console.error("[pizzapi-mcp] PIZZAPI_CC_BRIDGE_IPC not set — exiting");
  process.exit(1);
}

// ── IPC helpers ─────────────────────────────────────────────────────────

const IPC_TIMEOUT_GRACE_MS = 250;

async function callBridge(
  tool: string,
  args: unknown,
  timeoutMs = 25_000,
): Promise<unknown> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = createConnection(ipcPath!);
    let buf: Buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      socket.destroy();
      reject(new Error(`Bridge IPC timeout for tool ${tool}`));
    }, timeoutMs + IPC_TIMEOUT_GRACE_MS);

    socket.on("connect", () => {
      const msg: PluginMessage = {
        type: "mcp_call",
        tool,
        args,
        requestId,
      };
      socket.write(serializeFrame(msg));
    });

    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = framesFromBuffer(buf);
      buf = parsed.remaining;
      for (const frame of parsed.frames) {
        const f = frame as BridgeMessage;
        if (f.type === "mcp_response" && f.requestId === requestId) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          if (f.error) reject(new Error(f.error));
          else resolve(f.result);
        }
      }
    });

    socket.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    socket.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Bridge IPC closed before responding to tool ${tool}`));
    });
  });
}

// ── Tool definitions ────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "set_session_name",
    description:
      "Set a short display name for this session. Call this exactly once at the start of your first response with a 3–6 word summary of the user's request.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A 3–6 word summary of the session topic" },
      },
      required: ["name"],
    },
  },
  {
    name: "pizzapi_get_session_id",
    description: "Get this session's PizzaPi session ID.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pizzapi_list_models",
    description: "List models available on the runner.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pizzapi_spawn_session",
    description:
      "Spawn a new agent session on the PizzaPi runner. Returns { sessionId, shareUrl }.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The initial prompt for the new session" },
        model: {
          type: "object",
          description: "Model to use for the spawned session",
          properties: {
            provider: { type: "string", description: "Model provider (e.g. 'anthropic')" },
            id: { type: "string", description: "Model ID (e.g. 'claude-sonnet-4-20250514')" },
          },
          required: ["provider", "id"],
        },
        cwd: { type: "string", description: "Working directory for the session" },
        linked: { type: "boolean", description: "Whether to link as a child session (default true)" },
        runnerId: { type: "string", description: "Target runner ID (defaults to current runner)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "pizzapi_send_message",
    description: "Send a message to another agent session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Target session ID" },
        message: { type: "string", description: "Message content" },
      },
      required: ["sessionId", "message"],
    },
  },
  {
    name: "pizzapi_wait_for_message",
    description: "Wait for a message from another session (max 25s).",
    inputSchema: {
      type: "object",
      properties: {
        fromSessionId: { type: "string", description: "Session ID to wait for a message from" },
        timeout: { type: "number", description: "Timeout in ms (default 20000, max 25000)" },
      },
    },
  },
  {
    name: "pizzapi_check_messages",
    description: "Non-blocking check for pending messages from another session.",
    inputSchema: {
      type: "object",
      properties: {
        fromSessionId: { type: "string", description: "Optional session ID filter" },
      },
    },
  },
  {
    name: "pizzapi_respond_to_trigger",
    description: "Respond to a trigger from a child session.",
    inputSchema: {
      type: "object",
      properties: {
        triggerId: { type: "string", description: "The trigger ID to respond to" },
        response: { type: "string", description: "Response text" },
        action: { type: "string", description: 'Action: "ack" or "followUp" (default "ack")' },
      },
      required: ["triggerId", "response"],
    },
  },
  {
    name: "pizzapi_tell_child",
    description: "Send a message to a linked child session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Child session ID" },
        message: { type: "string", description: "Message to send" },
      },
      required: ["sessionId", "message"],
    },
  },
  {
    name: "pizzapi_escalate_trigger",
    description: "Escalate a trigger to the human viewer.",
    inputSchema: {
      type: "object",
      properties: {
        triggerId: { type: "string", description: "The trigger ID to escalate" },
        context: { type: "string", description: "Additional context for the viewer" },
      },
      required: ["triggerId"],
    },
  },
];

// ── Server setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: "pizzapi", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  // Local-only tool — no bridge call needed
  if (name === "pizzapi_get_session_id") {
    return {
      content: [{ type: "text" as const, text: sessionId }],
    };
  }

  // Validate tool name
  if (!TOOLS.find((t) => t.name === name)) {
    return {
      content: [{ type: "text" as const, text: `Error: unknown tool ${name}` }],
      isError: true,
    };
  }

  // Forward to bridge
  try {
    const result = await callBridge(name, args);
    return {
      content: [
        {
          type: "text" as const,
          text: typeof result === "string" ? result : JSON.stringify(result),
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
