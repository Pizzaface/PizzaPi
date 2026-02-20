import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import type { PizzaPiConfig } from "../config.js";

/**
 * Minimal MCP client transport + tool bridge.
 *
 * Supports:
 *  - STDIO transport via spawning a command
 *  - HTTP transport via POSTing JSON-RPC-ish MCP messages
 *
 * This is intentionally lightweight and only implements what we need:
 *  - listTools
 *  - callTool
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Json;
};

type McpListToolsResult = { tools: McpTool[] };

type McpCallToolResult = {
  content?: unknown;
  isError?: boolean;
  // Some MCP servers return structured content blocks.
  // We'll just forward as-is.
};

type McpClient = {
  name: string;
  listTools(): Promise<McpTool[]>;
  callTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<McpCallToolResult>;
  close(): void;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// STDIO client
// ─────────────────────────────────────────────────────────────────────────────

function createStdioMcpClient(opts: { name: string; command: string; args?: string[]; env?: Record<string, string> }): McpClient {
  const child: ChildProcessWithoutNullStreams = spawn(opts.command, opts.args ?? [], {
    stdio: "pipe",
    env: { ...process.env, ...(opts.env ?? {}) },
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  let buffer = "";

  function send(msg: any) {
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  function request(method: string, params?: any, signal?: AbortSignal): Promise<any> {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send(payload);

      const onAbort = () => {
        pending.delete(id);
        reject(new Error("MCP request aborted"));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (isRecord(msg) && typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if ("error" in msg) p.reject(new Error(String((msg as any).error?.message ?? "MCP error")));
        else p.resolve((msg as any).result);
      }
    }
  });

  child.on("exit", (code, sig) => {
    const err = new Error(`MCP stdio server exited (code=${code}, signal=${sig ?? ""})`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });

  child.on("error", (e) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  });

  return {
    name: opts.name,
    async listTools() {
      const res = (await request("tools/list")) as McpListToolsResult;
      return Array.isArray(res?.tools) ? res.tools : [];
    },
    async callTool(toolName: string, args: unknown, signal?: AbortSignal) {
      const res = await request("tools/call", { name: toolName, arguments: args ?? {} }, signal);
      return (res ?? {}) as McpCallToolResult;
    },
    close() {
      try { child.kill(); } catch {}
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP client
// ─────────────────────────────────────────────────────────────────────────────

function createHttpMcpClient(opts: { name: string; url: string; headers?: Record<string, string> }): McpClient {
  let nextId = 1;

  async function request(method: string, params?: any, signal?: AbortSignal): Promise<any> {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(payload),
      signal,
    });

    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    if (!json || typeof json !== "object") throw new Error("Invalid MCP response");
    if (json.error) throw new Error(String(json.error?.message ?? "MCP error"));
    return json.result;
  }

  return {
    name: opts.name,
    async listTools() {
      const res = (await request("tools/list")) as McpListToolsResult;
      return Array.isArray(res?.tools) ? res.tools : [];
    },
    async callTool(toolName: string, args: unknown, signal?: AbortSignal) {
      const res = await request("tools/call", { name: toolName, arguments: args ?? {} }, signal);
      return (res ?? {}) as McpCallToolResult;
    },
    close() {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export type McpConfig = {
  // Preferred format
  mcp?: {
    servers?: Array<
      | { name: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
      | { name: string; transport: "http"; url: string; headers?: Record<string, string> }
    >;
  };

  // Compatibility format (commonly used by MCP configs)
  // {
  //   "mcpServers": {
  //     "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }
  //   }
  // }
  mcpServers?: Record<
    string,
    | { command: string; args?: string[]; env?: Record<string, string> }
    | { url: string; headers?: Record<string, string> }
  >;
};

export async function createMcpClientsFromConfig(config: PizzaPiConfig & McpConfig): Promise<McpClient[]> {
  const clients: McpClient[] = [];

  // Preferred format
  for (const s of config.mcp?.servers ?? []) {
    if (!s || typeof s !== "object") continue;
    if (s.transport === "stdio") {
      clients.push(
        createStdioMcpClient({
          name: s.name,
          command: s.command,
          args: s.args,
          env: s.env,
        }),
      );
    } else if (s.transport === "http") {
      clients.push(
        createHttpMcpClient({
          name: s.name,
          url: s.url,
          headers: s.headers,
        }),
      );
    }
  }

  // Compatibility format: mcpServers map
  const mcpServers = config.mcpServers ?? {};
  for (const [name, def] of Object.entries(mcpServers)) {
    if (!def || typeof def !== "object") continue;

    if ("command" in def && typeof (def as any).command === "string") {
      const d = def as { command: string; args?: string[]; env?: Record<string, string> };
      clients.push(
        createStdioMcpClient({
          name,
          command: d.command,
          args: d.args,
          env: d.env,
        }),
      );
      continue;
    }

    if ("url" in def && typeof (def as any).url === "string") {
      const d = def as { url: string; headers?: Record<string, string> };
      clients.push(createHttpMcpClient({ name, url: d.url, headers: d.headers }));
    }
  }

  return clients;
}

export async function registerMcpTools(pi: any, config: PizzaPiConfig & McpConfig) {
  const clients = await createMcpClientsFromConfig(config);
  if (clients.length === 0) return { clients, toolCount: 0, toolNames: [] as string[], errors: [] as Array<{ server: string; error: string }> };

  let toolCount = 0;
  const toolNames: string[] = [];
  const errors: Array<{ server: string; error: string }> = [];

  for (const client of clients) {
    let tools: McpTool[] = [];
    try {
      tools = await client.listTools();
    } catch (err) {
      errors.push({ server: client.name, error: err instanceof Error ? err.message : String(err) });
      // ignore broken server
      continue;
    }

    for (const tool of tools) {
      if (!tool?.name) continue;
      const toolName = `mcp:${client.name}:${tool.name}`;
      toolCount++;
      toolNames.push(toolName);

      pi.registerTool({
        name: toolName,
        label: tool.name,
        description: tool.description ?? `MCP tool from ${client.name}`,
        // pi expects JSON schema-ish. MCP uses inputSchema.
        parameters: (tool.inputSchema ?? { type: "object", additionalProperties: true }) as any,
        async execute(_toolCallId: string, rawParams: unknown, signal: AbortSignal | undefined) {
          const result = await client.callTool(tool.name, rawParams ?? {}, signal);
          // Ensure we return something pi can render.
          if (result && typeof result === "object" && "content" in result) {
            return (result as any);
          }
          return { content: result };
        },
      });
    }
  }

  // Best-effort shutdown.
  pi.on?.("session_shutdown", () => {
    for (const c of clients) c.close();
  });

  return { clients, toolCount, toolNames, errors };
}
