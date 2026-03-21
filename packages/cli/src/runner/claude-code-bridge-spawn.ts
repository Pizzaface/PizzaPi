import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export interface ClaudeCodeSpawnOptions {
  sessionId: string;
  apiKey: string;
  relayUrl: string;
  /** Working directory. If undefined, the bridge should fall back to process.cwd(). */
  cwd: string | undefined;
  prompt?: string;
  parentSessionId?: string;
  model?: { provider: string; id: string };
}

/**
 * Resolve the bridge script path.
 * Tries the compiled JS path first (for packaged builds), then falls back to TS (for development).
 */
function resolveBridgeScript(): string {
  const currentDir = fileURLToPath(new URL(".", import.meta.url));
  const jsPath = join(currentDir, "claude-code-bridge.js");
  const tsPath = join(currentDir, "claude-code-bridge.ts");

  if (existsSync(jsPath)) {
    return jsPath;
  }
  return tsPath;
}

/**
 * Get the current bun executable path.
 * Falls back to "bun" if process.execPath doesn't point to a bun executable.
 */
function getBunExecutable(): string {
  // process.execPath points to the current executable (bun binary or node)
  const execPath = process.execPath ?? "";
  if (execPath && (execPath.includes("bun") || existsSync(execPath))) {
    return execPath;
  }
  // Fallback to "bun" in PATH
  return "bun";
}

export function spawnClaudeCodeSession(opts: ClaudeCodeSpawnOptions): ReturnType<typeof Bun.spawn> {
  const bridgeScript = resolveBridgeScript();
  const bunExe = getBunExecutable();

  const proc = Bun.spawn([bunExe, bridgeScript], {
    cwd: opts.cwd ?? process.cwd(),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PIZZAPI_SESSION_ID: opts.sessionId,
      PIZZAPI_WORKER_CWD: opts.cwd ?? process.cwd(),
      PIZZAPI_API_KEY: opts.apiKey,
      PIZZAPI_RELAY_URL: opts.relayUrl,
      ...(opts.prompt ? { PIZZAPI_WORKER_INITIAL_PROMPT: opts.prompt } : {}),
      ...(opts.model ? {
        PIZZAPI_WORKER_INITIAL_MODEL_PROVIDER: opts.model.provider,
        PIZZAPI_WORKER_INITIAL_MODEL_ID: opts.model.id,
      } : {}),
      ...(opts.parentSessionId ? { PIZZAPI_WORKER_PARENT_SESSION_ID: opts.parentSessionId } : {}),
    },
  });

  console.log(`[daemon] spawned Claude Code bridge pid=${proc.pid} session=${opts.sessionId}`);
  return proc;
}
