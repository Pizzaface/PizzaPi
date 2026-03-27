import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeCodeSpawnSessionBody {
  prompt?: string;
  cwd?: string;
  runnerId?: string;
  model?: { provider: string; id: string };
  parentSessionId?: string;
  workerType?: "pi" | "claude-code";
}

/**
 * Get the current runner ID from the state file.
 * Mirrors the logic in spawn-session.ts.
 */
function getRunnerIdFromState(): string | null {
  const statePath = process.env.PIZZAPI_RUNNER_STATE_PATH ?? join(homedir(), ".pizzapi", "runner.json");
  try {
    if (!existsSync(statePath)) return null;
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    return typeof state.runnerId === "string" ? state.runnerId : null;
  } catch {
    return null;
  }
}

export function buildSpawnSessionBody(args: Record<string, unknown>, parentSessionId: string): ClaudeCodeSpawnSessionBody {
  const body: ClaudeCodeSpawnSessionBody = {};

  if (typeof args.prompt === "string") body.prompt = args.prompt;

  // Default cwd to process.cwd() if not provided, matching spawn_session.ts behavior
  body.cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();

  // Default runnerId to state file value if not provided, matching spawn_session.ts behavior
  if (typeof args.runnerId === "string") {
    body.runnerId = args.runnerId;
  } else {
    const runnerId = getRunnerIdFromState();
    if (runnerId) {
      body.runnerId = runnerId;
    }
  }

  const model = args.model;
  if (
    model &&
    typeof model === "object" &&
    typeof (model as Record<string, unknown>).provider === "string" &&
    typeof (model as Record<string, unknown>).id === "string"
  ) {
    body.model = {
      provider: (model as Record<string, string>).provider,
      id: (model as Record<string, string>).id,
    };
  }

  if (args.linked !== false) {
    body.parentSessionId = parentSessionId;
  }

  // When spawning from a Claude Code session the child should also be a
  // Claude Code worker by default.  The caller can opt-out by explicitly
  // passing workerType: "pi".
  if (args.workerType === "pi") {
    body.workerType = "pi";
  } else if (args.workerType === "claude-code" || args.workerType === undefined) {
    body.workerType = "claude-code";
  } else {
    // Unknown value — fall back to claude-code (safe default in CC context)
    body.workerType = "claude-code";
  }

  return body;
}
