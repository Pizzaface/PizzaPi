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

const PROVIDER_TOOL_NAME_MAX_LENGTH = 64;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function shortHash(value: string): string {
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;

  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

function sanitizeToolNamePart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return sanitized || "tool";
}

function clampToolName(name: string, seed: string): string {
  if (name.length <= PROVIDER_TOOL_NAME_MAX_LENGTH) return name;

  const hash = shortHash(seed).slice(0, 8);
  const keep = Math.max(1, PROVIDER_TOOL_NAME_MAX_LENGTH - hash.length - 1);
  return `${name.slice(0, keep)}_${hash}`;
}

function allocateProviderSafeToolName(serverName: string, mcpToolName: string, usedNames: Set<string>): string {
  const source = `${serverName}:${mcpToolName}`;
  const normalizedBase = `mcp_${sanitizeToolNamePart(serverName).toLowerCase()}_${sanitizeToolNamePart(mcpToolName).toLowerCase()}`;

  const preferred = clampToolName(normalizedBase, source);
  if (!usedNames.has(preferred)) {
    usedNames.add(preferred);
    return preferred;
  }

  const hash = shortHash(source).slice(0, 8);
  const withHash = clampToolName(`${normalizedBase}_${hash}`, `${source}:${hash}`);
  if (!usedNames.has(withHash)) {
    usedNames.add(withHash);
    return withHash;
  }

  let counter = 2;
  while (true) {
    const candidate = clampToolName(`${normalizedBase}_${hash}_${counter}`, `${source}:${counter}`);
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    counter++;
  }
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
// HTTP client (plain JSON POST — legacy / simple servers)
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
// HTTP Streamable client (MCP spec 2025-03-26)
//
// Sends JSON-RPC over POST with Accept: application/json, text/event-stream.
// The server may respond with either:
//   - application/json  → single JSON-RPC response (handled like plain HTTP)
//   - text/event-stream → SSE stream; we read until we find the matching id
//
// Session lifecycle:
//   - Server may return mcp-session-id on any response; we attach it to all
//     subsequent requests.
//   - close() sends DELETE to the endpoint so the server can clean up.
// ─────────────────────────────────────────────────────────────────────────────

function createStreamableMcpClient(opts: { name: string; url: string; headers?: Record<string, string> }): McpClient {
  let nextId = 1;
  let sessionId: string | undefined;

  function buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(opts.headers ?? {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(extra ?? {}),
    };
  }

  async function parseSSE(res: Response, targetId: number, signal?: AbortSignal): Promise<any> {
    if (!res.body) throw new Error("MCP streamable: response body is null");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const abortHandler = () => reader.cancel().catch(() => {});
    signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by blank lines (\n\n or \r\n\r\n)
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";

        for (const event of events) {
          // Collect all "data:" lines within this event block
          let data = "";
          for (const line of event.split(/\r?\n/)) {
            if (line.startsWith("data:")) {
              data += line.slice(5).trimStart();
            }
          }
          if (!data) continue;

          let msg: any;
          try {
            msg = JSON.parse(data);
          } catch {
            continue;
          }

          if (!isRecord(msg)) continue;

          // Ignore notifications / requests that have no id
          if (!("id" in msg)) continue;

          if (msg.id === targetId || msg.id === String(targetId)) {
            if (msg.error) throw new Error(String((msg.error as any)?.message ?? "MCP error"));
            return (msg as any).result;
          }
        }
      }
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      reader.cancel().catch(() => {});
    }

    throw new Error("MCP streamable: SSE stream ended without a matching response");
  }

  async function request(method: string, params?: any, signal?: AbortSignal): Promise<any> {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    const res = await fetch(opts.url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(payload),
      signal,
    });

    // Capture / update session ID
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;

    if (!res.ok) throw new Error(`MCP streamable HTTP ${res.status}`);

    const ct = res.headers.get("content-type") ?? "";

    if (ct.includes("text/event-stream")) {
      return parseSSE(res, id, signal);
    }

    // Fallback: plain JSON
    const json = (await res.json().catch(() => null)) as any;
    if (!json || typeof json !== "object") throw new Error("MCP streamable: invalid JSON response");
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
    close() {
      // Best-effort session teardown
      if (sessionId) {
        const sid = sessionId;
        sessionId = undefined;
        fetch(opts.url, {
          method: "DELETE",
          headers: { ...(opts.headers ?? {}), "mcp-session-id": sid },
        }).catch(() => {});
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export type McpConfig = {
  // Preferred format
  mcp?: {
    servers?: Array<
      | { name: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
      | { name: string; transport: "http"; url: string; headers?: Record<string, string> }
      | { name: string; transport: "streamable"; url: string; headers?: Record<string, string> }
    >;
  };

  // Compatibility format (commonly used by MCP configs)
  // {
  //   "mcpServers": {
  //     "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
  //     "myserver":   { "url": "http://localhost:3000/mcp", "transport": "streamable" }
  //   }
  // }
  mcpServers?: Record<
    string,
    | { command: string; args?: string[]; env?: Record<string, string> }
    | { url: string; transport?: "http" | "streamable"; headers?: Record<string, string> }
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
    } else if (s.transport === "streamable") {
      clients.push(
        createStreamableMcpClient({
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
      const d = def as { url: string; transport?: "http" | "streamable"; headers?: Record<string, string> };
      if (d.transport === "streamable") {
        clients.push(createStreamableMcpClient({ name, url: d.url, headers: d.headers }));
      } else {
        clients.push(createHttpMcpClient({ name, url: d.url, headers: d.headers }));
      }
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
  const usedToolNames = new Set<string>();

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

      const sourceName = `mcp:${client.name}:${tool.name}`;
      const toolName = allocateProviderSafeToolName(client.name, tool.name, usedToolNames);

      toolCount++;
      toolNames.push(toolName);

      const parameters = (tool.inputSchema ?? { type: "object", additionalProperties: true }) as any;
      if (parameters && typeof parameters === "object" && "$schema" in parameters) {
        delete parameters.$schema;
      }

      pi.registerTool({
        name: toolName,
        label: `${client.name}:${tool.name}`,
        description: tool.description
          ? `${tool.description} (source: ${sourceName})`
          : `MCP tool from ${client.name} (source: ${sourceName})`,
        // pi expects JSON schema-ish. MCP uses inputSchema.
        parameters,
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
