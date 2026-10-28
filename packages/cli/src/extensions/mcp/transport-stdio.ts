/**
 * STDIO MCP transport.
 *
 * Spawns a child process and communicates over its stdin/stdout using
 * newline-delimited JSON-RPC 2.0 messages.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { expandHome, expandVars } from "../../config.js";
import { buildSpawnInvocation } from "./windows-command.js";
import {
  MCP_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_MODERN_ERROR_CODES,
  MCP_SUPPORTED_VERSIONS,
  MCP_CLIENT_INFO,
  modernRequestMeta,
  MCP_ELICITATION_CAPABILITY,
  isRecord,
  type McpClient,
  type McpListToolsResult,
  type McpCallToolResult,
  type McpElicitationHandler,
} from "./types.js";
import { requestWithMrtr } from "./mrtr.js";

export async function createStdioMcpClient(opts: {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Internal package-overlay metadata; never read from user config. */
  packageRoot?: string;
}): Promise<McpClient> {
  // Insert a package root after regular variables so literal @HOME@ etc. in
  // the canonical installed path are not interpreted as configuration tokens.
  const expandStdioValue = (value: string) => expandVars(expandHome(value)).replaceAll("@PACKAGE_ROOT@", opts.packageRoot ?? "@PACKAGE_ROOT@");
  const command = expandStdioValue(opts.command);
  const args = (opts.args ?? []).map(expandStdioValue);
  const cwd = opts.cwd ? expandStdioValue(opts.cwd) : undefined;
  const env = opts.env ? Object.fromEntries(Object.entries(opts.env).map(([key, value]) => [key, expandStdioValue(value)])) : undefined;
  const mergedEnv = { ...process.env, ...(env) };

  // STDIO MCP servers are trusted local processes spawned from the user's
  // config — NOT agent-generated commands. We do NOT wrap them with the
  // filesystem sandbox (wrapCommand). They need full filesystem access to
  // read/write their own data directories (e.g. Godmother → ~/Documents/AgentMemory).
  //
  // Expand ~ in command, args, and cwd so paths resolve correctly even when
  // launched by macOS launchd (LaunchAgent/LaunchDaemon) where shell tilde
  // expansion doesn't occur.


  // On Windows, `.cmd`/`.bat` shims (npx, npm-installed servers) cannot be
  // spawned directly — reroute through cmd.exe with PATHEXT resolution.
  const invocation = buildSpawnInvocation(command, args);
  const child: ChildProcessWithoutNullStreams = spawn(invocation.command, invocation.args, {
    stdio: "pipe",
    env: mergedEnv,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    ...(cwd ? { cwd } : {}),
  });

  const lifetime = new AbortController();
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; cleanup: () => void }>();
  let buffer = "";

  function send(msg: any) {
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  function notifyCancelled(requestId: number) {
    try {
      if (!child.stdin.destroyed) {
        send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "Client cancelled request" } });
      }
    } catch {
      // Best-effort notification; local cancellation must still win.
    }
  }

  function request(method: string, params?: any, signal?: AbortSignal): Promise<any> {
    signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        pending.delete(id);
        // Per spec, `initialize` MUST NOT be cancelled — never notify for it.
        // A response that already arrived removed this listener via
        // cleanup() before onAbort could run, so no extra guard is needed
        // for the abort-after-completion race.
        if (method !== "initialize") notifyCancelled(id);
        reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      pending.set(id, { resolve, reject, cleanup });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      send(payload);
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

      if (isRecord(msg) && "id" in msg && typeof msg.method === "string") {
        // Modern MCP forbids server-initiated requests. Reject explicitly, and
        // never mistake a colliding request id for a response to our request.
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Server-initiated requests are not supported" } });
        continue;
      }
      if (isRecord(msg) && typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        p.cleanup();
        if ("error" in msg) {
          const error = (msg as any).error;
          const e = new Error(String(error?.message ?? "MCP error")) as Error & { code?: number; data?: unknown };
          e.code = error?.code;
          e.data = error?.data;
          p.reject(e);
        } else p.resolve((msg as any).result);
      }
    }
  });

  child.on("exit", (code, sig) => {
    const err = new Error(`MCP stdio server exited (code=${code}, signal=${sig ?? ""})`);
    lifetime.abort(err);
    for (const p of pending.values()) { p.cleanup(); p.reject(err); }
    pending.clear();
  });

  const fail = (e: Error) => {
    lifetime.abort(e);
    for (const p of pending.values()) { p.cleanup(); p.reject(e); }
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);

  // Probe modern MCP first; only non-modern failures fall back to legacy initialize.
  let initPromise: Promise<void> | null = null;
  let modern = false;

  function modernParams(params: Record<string, unknown> = {}, capabilities: Record<string, unknown> = {}) {
    return { ...params, _meta: modernRequestMeta(capabilities) };
  }

  function ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (!initPromise) initPromise = (async () => {
      const probe = new AbortController();
      // Resolves true (modern), false (not modern: fall back), or rejects on a modern-era error.
      const discovered = request("server/discover", modernParams(), signal ? AbortSignal.any([signal, probe.signal]) : probe.signal).then(d => {
        if (!isRecord(d) || !Array.isArray(d.supportedVersions)) return false;
        if (!d.supportedVersions.includes(MCP_MODERN_PROTOCOL_VERSION)) {
          throw Object.assign(new Error(`MCP server "${opts.name}" does not support ${MCP_MODERN_PROTOCOL_VERSION}`), { code: -32022 });
        }
        return true;
      }, err => {
        const code = (err as { code?: number }).code;
        if (signal?.aborted || lifetime.signal.aborted || (typeof code === "number" && MCP_MODERN_ERROR_CODES.has(code))) throw err;
        return false;
      });

      // Legacy servers may silently ignore unknown methods, so after 1s also
      // send initialize. Discovery stays pending: a slow-starting dual-era
      // server locks to modern on the first request and rejects initialize.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const first = await Promise.race([discovered, new Promise<"late">(r => { timer = setTimeout(r, 1000, "late"); })])
        .finally(() => clearTimeout(timer));
      if (first === true) { modern = true; return; }
      const legacy = legacyInitialize(signal);
      if (first === false) return legacy;
      const era = await Promise.any([
        discovered.then(ok => ok ? "modern" as const : Promise.reject(new Error("not modern"))),
        legacy.then(() => "legacy" as const),
      ]).catch((e: AggregateError) => { throw e.errors[1]; });
      if (era === "modern") modern = true;
      else probe.abort();
    })();
    return initPromise;
  }

  async function legacyInitialize(signal?: AbortSignal) {
    const result = await request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO }, signal);
    if (result?.protocolVersion && !MCP_SUPPORTED_VERSIONS.has(result.protocolVersion)) {
      throw new Error(`MCP server "${opts.name}" returned unsupported protocol version: ${result.protocolVersion}`);
    }
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  return {
    name: opts.name,
    initialize: (signal?: AbortSignal) => ensureInitialized(signal),
    async listTools() {
      await ensureInitialized();
      const res = (await request("tools/list", modern ? modernParams() : undefined)) as McpListToolsResult;
      return Array.isArray(res?.tools) ? res.tools : [];
    },
    async callTool(toolName: string, args: unknown, signal?: AbortSignal, onElicitation?: McpElicitationHandler) {
      signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      await ensureInitialized(signal);
      const base = { name: toolName, arguments: args ?? {} };
      const res = modern
        ? await requestWithMrtr(
            (params, requestSignal) => request("tools/call", modernParams(params, onElicitation ? MCP_ELICITATION_CAPABILITY : {}), requestSignal),
            base,
            onElicitation,
            signal,
          )
        : await request("tools/call", base, signal);
      return (res ?? {}) as McpCallToolResult;
    },
    close() {
      lifetime.abort();
      try { child.kill(); } catch {}
    },
  };
}
