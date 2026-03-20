import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

const BRIDGE_SCRIPT = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "claude-code-bridge.ts",
);

export function spawnClaudeCodeSession(opts: ClaudeCodeSpawnOptions): void {
  const proc = Bun.spawn(["bun", BRIDGE_SCRIPT], {
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
      ...(opts.parentSessionId ? { PIZZAPI_WORKER_PARENT_SESSION_ID: opts.parentSessionId } : {}),
    },
  });

  console.log(`[daemon] spawned Claude Code bridge pid=${proc.pid} session=${opts.sessionId}`);
}
