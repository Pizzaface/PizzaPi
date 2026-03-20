/**
 * Stub for Claude Code bridge session spawning.
 * Real implementation arrives in Plan 2.
 */
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

export function spawnClaudeCodeSession(opts: ClaudeCodeSpawnOptions): void {
  console.warn(
    `[claude-code-bridge] spawnClaudeCodeSession called for session ${opts.sessionId} — ` +
    `not yet implemented. Bridge will not start.`
  );
  // TODO(Plan 2): spawn the bridge process here
}
