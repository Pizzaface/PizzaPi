import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Server } from "bun";

// ── Service settings helpers ───────────────────────────────────────────────

function settingsFilePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "settings.json");
}

function readServiceSettings(): Record<string, unknown> {
  try {
    const p = settingsFilePath();
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function writeServiceSettings(data: Record<string, unknown>): void {
  writeFileSync(settingsFilePath(), JSON.stringify(data, null, 2), "utf-8");
}

// ── Runner identity helpers ────────────────────────────────────────────────

function getRunnerStatePath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".pizzapi", "runner.json");
}

function readRunnerId(): string | null {
  try {
    const statePath = getRunnerStatePath();
    if (!existsSync(statePath)) return null;
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    return typeof raw?.runnerId === "string" ? raw.runnerId : null;
  } catch {
    return null;
  }
}

function resolveRelayUrl(): string {
  const home = process.env.HOME || homedir();
  const configPath = join(home, ".pizzapi", "config.json");

  // Env var takes priority
  let raw = process.env.PIZZAPI_RELAY_URL?.trim();

  // Fall back to config.json
  if (!raw && existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (typeof cfg?.relayUrl === "string" && cfg.relayUrl !== "off") {
        raw = cfg.relayUrl.trim();
      }
    } catch { /* ignore */ }
  }

  raw = raw || "http://localhost:7492";

  // Normalise scheme: ws → http, wss → https
  if (raw.startsWith("ws://"))  return raw.replace(/^ws:\/\//, "http://").replace(/\/$/, "");
  if (raw.startsWith("wss://")) return raw.replace(/^wss:\/\//, "https://").replace(/\/$/, "");
  return raw.replace(/\/$/, "");
}

function getApiKey(): string | null {
  return (
    process.env.PIZZAPI_RUNNER_API_KEY ??
    process.env.PIZZAPI_API_KEY ??
    process.env.PIZZAPI_API_TOKEN ??
    null
  );
}

type JsonRpcPending = {
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type McpServerConfig = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export function resolveGodmotherMcpConfig(
  server: McpServerConfig,
  configPath: string,
): McpServerConfig {
  const baseDir = dirname(configPath);

  const resolvePathLike = (value: string): string => {
    const raw = value.trim();
    if (!raw) return raw;
    if (raw.startsWith("~")) {
      return join(homedir(), raw.slice(1));
    }
    if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
      return raw;
    }
    if (raw.startsWith(".") || raw.includes("/") || raw.includes("\\")) {
      return join(baseDir, raw);
    }
    return raw;
  };

  return {
    command: resolvePathLike(server.command),
    ...(Array.isArray(server.args)
      ? { args: server.args.map((arg) => (typeof arg === "string" ? resolvePathLike(arg) : String(arg))) }
      : {}),
    ...(typeof server.cwd === "string" && server.cwd.trim()
      ? { cwd: resolvePathLike(server.cwd) }
      : {}),
    ...(server.env ? { env: server.env } : {}),
  };
}

const MCP_PROTOCOL_VERSION = "2025-03-26";
const MCP_CLIENT_INFO = { name: "godmother-panel", version: "0.1.0" };
const DEFAULT_TIMEOUT_MS = 15_000;

function routeMatches(pathname: string, route: string): boolean {
  return pathname === route || pathname.endsWith(route);
}

export function splitTopics(input: string | string[] | undefined | null): string[] {
  if (Array.isArray(input)) {
    return Array.from(new Set(input.map((t) => String(t).trim()).filter(Boolean)));
  }
  if (!input) return [];
  return Array.from(
    new Set(
      input
        .split(/[\n,]/g)
        .map((topic) => topic.trim())
        .filter(Boolean),
    ),
  );
}

export function buildPanelDeepLink({
  serviceId,
  hash,
  query,
}: {
  serviceId: string;
  hash?: string;
  query?: URLSearchParams;
}): string {
  const qs = query?.toString();
  const fragment = hash?.replace(/^#/, "");
  const encodedService = encodeURIComponent(serviceId.trim());
  return `pizzapi://panel/${encodedService}${qs ? `?${qs}` : ""}${fragment ? `#${fragment}` : ""}`;
}

export function parseMcpToolResultText(result: any): unknown {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks.find((block: any) => typeof block?.text === "string")?.text;

  if (result?.isError) {
    throw new Error(text || "Godmother MCP tool call failed");
  }

  if (!text) {
    throw new Error("Godmother MCP response missing text payload");
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type RunnerModel = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  available?: boolean;
  [key: string]: unknown;
};

export function parseRequestedModel(input: unknown): { provider: string; id: string } | null {
  if (!input || typeof input !== "object") return null;
  const provider = typeof (input as any)?.provider === "string" ? (input as any).provider.trim() : "";
  const id = typeof (input as any)?.id === "string" ? (input as any).id.trim() : "";
  if (!provider || !id) return null;
  return { provider, id };
}

function forwardAuthHeaders(req: Request): HeadersInit {
  const headers: Record<string, string> = {};
  for (const key of ["cookie", "authorization", "x-api-key"]) {
    const value = req.headers.get(key);
    if (value) headers[key] = value;
  }
  return headers;
}

async function fetchRunnerModels(req: Request, runnerId: string): Promise<RunnerModel[]> {
  const relayUrl = resolveRelayUrl();
  const res = await fetch(`${relayUrl}/api/runners/${encodeURIComponent(runnerId)}/models`, {
    headers: forwardAuthHeaders(req),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as any)?.error || `Failed to load models (${res.status})`);
  }
  return Array.isArray((body as any)?.models) ? (body as any).models : [];
}

function getGodmotherMcpConfig(): McpServerConfig {
  const home = process.env.HOME || homedir();
  const configPath = join(home, ".pizzapi", "config.json");

  if (!existsSync(configPath)) {
    throw new Error(`Missing PizzaPi config at ${configPath}`);
  }

  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  const server = raw?.mcpServers?.godmother;

  if (!server || typeof server !== "object") {
    throw new Error("Missing mcpServers.godmother config in ~/.pizzapi/config.json");
  }

  if (typeof server.command !== "string" || !server.command.trim()) {
    throw new Error("mcpServers.godmother.command must be a non-empty string");
  }

  const normalized = resolveGodmotherMcpConfig(
    {
      command: server.command,
      args: Array.isArray(server.args) ? server.args.map((v: unknown) => String(v)) : [],
      cwd: typeof server.cwd === "string" ? server.cwd : undefined,
      env:
        server.env && typeof server.env === "object"
          ? Object.fromEntries(
              Object.entries(server.env).map(([k, v]) => [k, String(v)]),
            )
          : undefined,
    },
    configPath,
  );

  return normalized;
}

class StdioMcpBridge {
  #child: ChildProcessWithoutNullStreams;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, JsonRpcPending>();
  #initPromise: Promise<void> | null = null;

  constructor(private readonly cfg: McpServerConfig) {
    this.#child = spawn(cfg.command, cfg.args ?? [], {
      stdio: "pipe",
      env: { ...process.env, ...(cfg.env ?? {}) },
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
    });

    this.#child.stdout.on("data", (chunk) => this.#handleStdout(chunk.toString("utf-8")));
    this.#child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf-8").trim();
      if (text) {
        console.error("[godmother-panel] MCP stderr:", text);
      }
    });
    this.#child.on("error", (err) => this.#failAllPending(err));
    this.#child.on("exit", (code, signal) => {
      this.#failAllPending(
        new Error(`Godmother MCP exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
      );
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    await this.#ensureInitialized();
    return this.#request("tools/call", { name, arguments: args });
  }

  close() {
    this.#failAllPending(new Error("Godmother MCP bridge closed"));
    try {
      this.#child.kill();
    } catch {
      // no-op
    }
  }

  async #ensureInitialized(): Promise<void> {
    if (!this.#initPromise) {
      this.#initPromise = (async () => {
        await this.#request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        });
        this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
      })();
    }
    return this.#initPromise;
  }

  #request(method: string, params?: unknown): Promise<any> {
    const id = this.#nextId++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Godmother MCP request timed out for method ${method}`));
      }, DEFAULT_TIMEOUT_MS);

      this.#pending.set(id, { resolve, reject, timeout });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #send(payload: any) {
    this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #handleStdout(chunk: string) {
    this.#buffer += chunk;

    while (true) {
      const lineBreak = this.#buffer.indexOf("\n");
      if (lineBreak < 0) break;

      const line = this.#buffer.slice(0, lineBreak).trim();
      this.#buffer = this.#buffer.slice(lineBreak + 1);
      if (!line) continue;

      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      if (typeof message?.id !== "number") continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;

      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(String(message.error?.message ?? "MCP error")));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #failAllPending(err: unknown) {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.#pending.clear();
  }
}

async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

class GodmotherPanelService {
  get id() {
    return "godmother-panel";
  }

  #server: Server | null = null;
  #mcp: StdioMcpBridge | null = null;
  #bootError: string | null = null;

  init(_socket: any, { announcePanel }: { announcePanel?: (port: number) => void }) {
    const panelDir = join(dirname(fileURLToPath(import.meta.url)), "panel");
    const indexPath = join(panelDir, "index.html");

    try {
      this.#mcp = new StdioMcpBridge(getGodmotherMcpConfig());
    } catch (err) {
      this.#bootError = err instanceof Error ? err.message : String(err);
      this.#mcp = null;
      console.error("[godmother-panel] failed to initialize MCP bridge:", err);
    }

    this.#server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);

        if (req.method === "OPTIONS") {
          return json({ ok: true });
        }

        if (routeMatches(url.pathname, "/api/health")) {
          return json({
            ok: !this.#bootError,
            mcpReady: !this.#bootError,
            error: this.#bootError,
          });
        }

        // ── Settings — read/write service settings.json ──────────────────
        if (routeMatches(url.pathname, "/api/settings")) {
          if (req.method === "GET") {
            return json({ settings: readServiceSettings() });
          }
          if (req.method === "POST") {
            const body = await readJson(req);
            // Only persist known safe keys
            const saved: Record<string, unknown> = {};
            if (typeof body?.defaultCwd === "string") saved.defaultCwd = body.defaultCwd.trim();
            if (body?.projectCwds && typeof body.projectCwds === "object" && !Array.isArray(body.projectCwds)) {
              const cleaned: Record<string, string> = {};
              for (const [k, v] of Object.entries(body.projectCwds as Record<string, unknown>)) {
                if (typeof v === "string" && v.trim()) cleaned[k] = v.trim();
              }
              saved.projectCwds = cleaned;
            }
            try {
              writeServiceSettings(saved);
              return json({ ok: true });
            } catch (err) {
              return json({ error: err instanceof Error ? err.message : String(err) }, 500);
            }
          }
        }

        // ── Models — proxy PizzaPi's available runner models ─────────────
        if (routeMatches(url.pathname, "/api/models") && req.method === "GET") {
          const runnerId = readRunnerId();
          if (!runnerId) {
            return json({ error: "Runner identity not found — runner.json missing or unreadable" }, 500);
          }

          try {
            const models = await fetchRunnerModels(req, runnerId);
            return json({ models });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 500);
          }
        }

        // ── Spawn session — does NOT require the MCP bridge ──────────────
        if (routeMatches(url.pathname, "/api/spawn-session") && req.method === "POST") {
          const body = await readJson(req);
          const cwd = typeof body?.cwd === "string" ? body.cwd.trim() : undefined;
          const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : undefined;
          const model = parseRequestedModel(body?.model) || undefined;

          const apiKey = getApiKey();
          if (!apiKey) {
            return json({ error: "No API key configured — set PIZZAPI_API_KEY in the runner environment" }, 500);
          }

          const runnerId = readRunnerId();
          if (!runnerId) {
            return json({ error: "Runner identity not found — runner.json missing or unreadable" }, 500);
          }

          const relayUrl = resolveRelayUrl();

          let spawnRes: Response;
          try {
            spawnRes = await fetch(`${relayUrl}/api/runners/spawn`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
              },
              body: JSON.stringify({
                runnerId,
                ...(cwd ? { cwd } : {}),
                ...(prompt ? { prompt } : {}),
                ...(model?.provider && model?.id ? { model } : {}),
              }),
            });
          } catch (err) {
            return json({ error: `Failed to reach relay: ${err instanceof Error ? err.message : String(err)}` }, 502);
          }

          const spawnData = await spawnRes.json().catch(() => ({}));
          if (!spawnRes.ok) {
            return json({ error: (spawnData as any)?.error ?? `Relay error ${spawnRes.status}` }, spawnRes.status);
          }

          const sessionId = (spawnData as any)?.sessionId as string | undefined;

          // Fire the godmother:spawn_session trigger to all subscribed sessions.
          // Best-effort — don't fail the spawn response if broadcast errors.
          if (sessionId) {
            void fetch(`${relayUrl}/api/runners/${runnerId}/trigger-broadcast`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
              },
              body: JSON.stringify({
                type: "godmother:spawn_session",
                payload: { sessionId, runnerId, cwd: cwd ?? null },
                source: "godmother-panel",
                summary: "Session spawned from Godmother",
                deliverAs: "followUp",
              }),
            }).catch((err) => {
              console.error("[godmother-panel] trigger broadcast failed:", err);
            });
          }

          return json({ ok: true, sessionId, runnerId });
        }

        if (!this.#mcp) {
          return json(
            {
              error: this.#bootError ?? "Godmother MCP bridge unavailable",
            },
            500,
          );
        }

        try {
          if (routeMatches(url.pathname, "/api/list") && req.method === "GET") {
            const project = url.searchParams.get("project")?.trim() || undefined;
            const status = url.searchParams.get("status")?.trim() || undefined;
            const includeCompleted = url.searchParams.get("includeCompleted") === "true";
            const topics = splitTopics(url.searchParams.get("topics"));

            const result = await this.#mcp.callTool("list_ideas", {
              ...(project ? { project } : {}),
              ...(status ? { status } : {}),
              ...(topics.length > 0 ? { topics } : {}),
              ...(includeCompleted ? { include_completed: true } : {}),
            });
            return json({ items: parseMcpToolResultText(result) });
          }

          if (routeMatches(url.pathname, "/api/search") && req.method === "GET") {
            const query = url.searchParams.get("query")?.trim();
            if (!query) {
              return json({ error: "query is required" }, 400);
            }
            const project = url.searchParams.get("project")?.trim() || undefined;
            const status = url.searchParams.get("status")?.trim() || undefined;
            const limit = Number(url.searchParams.get("limit") || "15");

            const result = await this.#mcp.callTool("search_ideas", {
              query,
              ...(project ? { project } : {}),
              ...(status ? { status } : {}),
              ...(Number.isFinite(limit) ? { limit } : {}),
            });
            return json({ items: parseMcpToolResultText(result) });
          }

          if (routeMatches(url.pathname, "/api/projects") && req.method === "GET") {
            const result = await this.#mcp.callTool("list_projects", {});
            return json({ projects: parseMcpToolResultText(result) });
          }

          if (routeMatches(url.pathname, "/api/capture") && req.method === "POST") {
            const body = await readJson(req);
            const description = String(body?.description ?? body?.content ?? "").trim();
            const summary = String(body?.summary ?? "").trim();
            const project = String(body?.project ?? "PizzaPi").trim();
            const topics = splitTopics(body?.topics);

            if (!description) {
              return json({ error: "description is required" }, 400);
            }
            if (!project) {
              return json({ error: "project is required" }, 400);
            }

            const result = await this.#mcp.callTool("capture_idea", {
              description,
              project,
              ...(summary ? { summary } : {}),
              ...(topics.length > 0 ? { topics } : {}),
            });
            return json({ idea: parseMcpToolResultText(result) });
          }

          if (routeMatches(url.pathname, "/api/move") && req.method === "POST") {
            const body = await readJson(req);
            const id = String(body?.id ?? "").trim();
            const to = String(body?.to ?? "").trim();
            if (!id || !to) {
              return json({ error: "id and to are required" }, 400);
            }

            const result = await this.#mcp.callTool("move_idea", { id, to });
            return json({ result: parseMcpToolResultText(result) });
          }

          if (routeMatches(url.pathname, "/api/archive") && req.method === "POST") {
            const body = await readJson(req);
            const id = String(body?.id ?? "").trim();
            if (!id) {
              return json({ error: "id is required" }, 400);
            }

            const result = await this.#mcp.callTool("archive_idea", { id });
            return json({ result: parseMcpToolResultText(result) });
          }

          if (routeMatches(url.pathname, "/api/delete") && req.method === "POST") {
            const body = await readJson(req);
            const id = String(body?.id ?? "").trim();
            if (!id) {
              return json({ error: "id is required" }, 400);
            }

            const result = await this.#mcp.callTool("delete_idea", { id });
            return json({ result: parseMcpToolResultText(result) });
          }

          if (routeMatches(url.pathname, "/api/get") && req.method === "GET") {
            const id = url.searchParams.get("id")?.trim();
            if (!id) {
              return json({ error: "id is required" }, 400);
            }

            const result = await this.#mcp.callTool("get_idea", { id });
            return json({ idea: parseMcpToolResultText(result) });
          }

          // ── Sigil resolve routes ───────────────────────────────────────

          const ideaResolveMatch = url.pathname.match(/\/api\/resolve\/idea\/(.+)$/);
          if (ideaResolveMatch && req.method === "GET") {
            const id = decodeURIComponent(ideaResolveMatch[1]);
            const result = await this.#mcp.callTool("get_idea", { id });
            const idea = parseMcpToolResultText(result) as any;
            const statusIcons: Record<string, string> = {
              capture: "📥", triage: "🔍", design: "✏️", plan: "📋",
              execute: "🔨", completed: "✅", review: "👀", shipped: "🚀",
            };
            const icon = statusIcons[idea?.status] ?? "💡";
            const sigilParams = new URLSearchParams(url.searchParams);
            return json({
              id: idea?.id ?? id,
              title: idea?.summary || idea?.description?.slice(0, 80) || id,
              subtitle: `${icon} ${idea?.status ?? "unknown"} · ${idea?.project ?? ""}`.trim(),
              url: buildPanelDeepLink({
                serviceId: "godmother-panel",
                query: sigilParams,
                hash: `idea/${encodeURIComponent(idea?.id ?? id)}`,
              }),
            });
          }

          const epicResolveMatch = url.pathname.match(/\/api\/resolve\/epic\/(.+)$/);
          if (epicResolveMatch && req.method === "GET") {
            const id = decodeURIComponent(epicResolveMatch[1]);
            const result = await this.#mcp.callTool("get_epic", { id });
            const epic = parseMcpToolResultText(result) as any;
            const resolvedRatio = epic?.resolved_ratio != null
              ? `${Math.round(epic.resolved_ratio * 100)}%`
              : "";
            const sigilParams = new URLSearchParams(url.searchParams);
            return json({
              id: epic?.id ?? id,
              title: epic?.title || id,
              subtitle: `📦 ${epic?.status ?? "unknown"}${resolvedRatio ? ` · ${resolvedRatio} done` : ""} · ${epic?.project ?? ""}`.trim(),
              url: buildPanelDeepLink({
                serviceId: "godmother-panel",
                query: sigilParams,
                hash: `epic/${encodeURIComponent(epic?.id ?? id)}`,
              }),
            });
          }

          if (routeMatches(url.pathname, "/api/epics") && req.method === "GET") {
            const project = url.searchParams.get("project")?.trim() || undefined;
            const status = url.searchParams.get("status")?.trim() || undefined;

            const result = await this.#mcp.callTool("list_epics", {
              ...(project ? { project } : {}),
              ...(status ? { status } : {}),
            });
            return json({ epics: parseMcpToolResultText(result) });
          }
        } catch (err) {
          console.error("[godmother-panel] request error:", err);
          return json(
            {
              error: err instanceof Error ? err.message : String(err),
            },
            500,
          );
        }

        // Serve static assets from panel dir
        const fileName = url.pathname.split("/").pop() || "";
        const MIME: Record<string, string> = {
          ".css": "text/css",
          ".js": "application/javascript",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".json": "application/json",
        };
        const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "";
        if (ext && MIME[ext]) {
          const filePath = join(panelDir, fileName);
          if (existsSync(filePath)) {
            return new Response(readFileSync(filePath), {
              headers: {
                "Content-Type": `${MIME[ext]}; charset=utf-8`,
                "Access-Control-Allow-Origin": "*",
              },
            });
          }
        }

        // Read index.html fresh each time so edits are picked up without restart
        const html = existsSync(indexPath)
          ? readFileSync(indexPath, "utf-8")
          : "<html><body>godmother-panel: panel/index.html not found</body></html>";
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    });

    const port = this.#server.port;
    console.log(`[godmother-panel] HTTP server on port ${port}`);
    announcePanel?.(port);
  }

  dispose() {
    this.#mcp?.close();
    this.#mcp = null;

    if (this.#server) {
      this.#server.stop(true);
      this.#server = null;
    }
  }
}

export default GodmotherPanelService;
