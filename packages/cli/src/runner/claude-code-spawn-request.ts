export interface ClaudeCodeSpawnSessionBody {
  prompt?: string;
  cwd?: string;
  runnerId?: string;
  model?: { provider: string; id: string };
  parentSessionId?: string;
}

export function buildSpawnSessionBody(args: Record<string, unknown>, parentSessionId: string): ClaudeCodeSpawnSessionBody {
  const body: ClaudeCodeSpawnSessionBody = {};

  if (typeof args.prompt === "string") body.prompt = args.prompt;
  if (typeof args.cwd === "string") body.cwd = args.cwd;
  if (typeof args.runnerId === "string") body.runnerId = args.runnerId;

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

  return body;
}
