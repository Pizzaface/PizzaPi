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
  /** Models to hide from the model picker (same format as pi worker: "provider/id"). */
  hiddenModels?: string[];
}

/**
 * Resolve the bridge script path.
 *
 * Search order:
 *  1. Compiled JS next to this module file (dev build: dist/runner/claude-code-bridge.js)
 *  2. TS source next to this module file (dev source checkout)
 *  3. runner/claude-code-bridge.js next to the pizza binary (packaged/npm install)
 *
 * In a Bun single-file compiled binary, import.meta.url resolves to a virtual
 * path inside the bundle that doesn't exist on disk, so checks 1 and 2 will
 * return false and we fall through to check 3 (the sidecar runner/ directory).
 */
function resolveBridgeScript(): string {
  const currentDir = fileURLToPath(new URL(".", import.meta.url));
  const jsPath = join(currentDir, "claude-code-bridge.js");
  const tsPath = join(currentDir, "claude-code-bridge.ts");

  if (existsSync(jsPath)) return jsPath;
  if (existsSync(tsPath)) return tsPath;

  // Compiled/binary install: build-binaries.ts copies runner/ next to the executable.
  const binDir = dirname(process.execPath);
  const runnerJsPath = join(binDir, "runner", "claude-code-bridge.js");
  if (existsSync(runnerJsPath)) return runnerJsPath;

  throw new Error(
    `Claude Code bridge script not found.\n` +
    `  Checked: ${jsPath}\n` +
    `  Checked: ${tsPath}\n` +
    `  Checked: ${runnerJsPath}\n` +
    `Run 'bun run build' in packages/cli to generate the compiled bridge.`,
  );
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
      ...(opts.hiddenModels && opts.hiddenModels.length > 0
        ? { PIZZAPI_HIDDEN_MODELS: JSON.stringify(opts.hiddenModels) }
        : {}),
    },
  });

  console.log(`[daemon] spawned Claude Code bridge pid=${proc.pid} session=${opts.sessionId}`);
  return proc;
}
