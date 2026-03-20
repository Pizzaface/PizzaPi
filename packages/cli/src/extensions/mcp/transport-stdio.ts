/**
 * STDIO MCP transport.
 *
 * Spawns a child process and communicates over its stdin/stdout using
 * newline-delimited JSON-RPC 2.0 messages.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { expandHome } from "../../config.js";
import { getSandboxEnv, isSandboxActive } from "@pizzapi/tools";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  MCP_CLIENT_INFO,
  isRecord,
  type McpClient,
  type McpListToolsResult,
  type McpCallToolResult,
} from "./types.js";

export async function createStdioMcpClient(opts: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}): Promise<McpClient> {
  // Sandbox: inject proxy env vars so sandboxed MCP servers route traffic
  // through the sandbox network proxy. User-provided env takes precedence.
  const sandboxEnv = isSandboxActive() ? getSandboxEnv() : {};
  // Sandbox env vars (proxy settings) spread LAST so MCP server config cannot
  // override them to bypass network filtering.
  const mergedEnv = { ...process.env, ...(opts.env ?? {}), ...sandboxEnv };

  // STDIO MCP servers are trusted local processes spawned from the user's
  // config — NOT agent-generated commands. We do NOT wrap them with the
  // filesystem sandbox (wrapCommand). They need full filesystem access to
  // read/write their own data directories (e.g. Godmother → ~/Documents/AgentMemory).
  //
  // Network sandboxing still applies via the proxy env vars injected above —
  // outbound traffic is routed through srt's proxy for domain filtering when
  // sandbox is active in "full" mode.
  // Expand ~ in command, args, and cwd so paths resolve correctly even when
  // launched by macOS launchd (LaunchAgent/LaunchDaemon) where shell tilde
  // expansion doesn't occur.
  const command = expandHome(opts.command);
  const args = (opts.args ?? []).map(expandHome);
  const cwd = opts.cwd ? expandHome(opts.cwd) : undefined;

  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    stdio: "pipe",
    env: mergedEnv,
    ...(cwd ? { cwd } : {}),
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

  // ── Lazy MCP initialize handshake ──────────────────────────────────────
  let initPromise: Promise<void> | null = null;

  function ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        const result = await request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        }, signal);

        if (result?.protocolVersion && !MCP_SUPPORTED_VERSIONS.has(result.protocolVersion)) {
          throw new Error(`MCP server "${opts.name}" returned unsupported protocol version: ${result.protocolVersion}`);
        }

        // Send the initialized notification (no id → notification, no response expected)
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
      })();
    }
    return initPromise;
  }

  return {
    name: opts.name,
    initialize: (signal?: AbortSignal) => ensureInitialized(signal),
    async listTools() {
      await ensureInitialized();
      const res = (await request("tools/list")) as McpListToolsResult;
      return Array.isArray(res?.tools) ? res.tools : [];
    },
    async callTool(toolName: string, args: unknown, signal?: AbortSignal) {
      await ensureInitialized();
      const res = await request("tools/call", { name: toolName, arguments: args ?? {} }, signal);
      return (res ?? {}) as McpCallToolResult;
    },
    close() {
      try { child.kill(); } catch {}
    },
  };
}
