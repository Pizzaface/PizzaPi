export interface HubSessionPayload {
  sessionId: string;
  shareUrl: string;
  cwd: string;
  startedAt: string;
  viewerCount?: number;
  userId?: string;
  userName?: string;
  sessionName?: string | null;
  isEphemeral?: boolean;
  expiresAt?: string | null;
  isActive?: boolean;
  lastHeartbeatAt?: string | null;
  model?: { provider: string; id: string; name?: string } | null;
  runnerId?: string | null;
  runnerName?: string | null;
  isPinned?: boolean;
  parentSessionId?: string | null;
}

function isHubSession(value: unknown): value is HubSessionPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "string" &&
    typeof v.shareUrl === "string" &&
    typeof v.cwd === "string" &&
    typeof v.startedAt === "string"
  );
}

export function parseHubSessionsPayload(payload: unknown): HubSessionPayload[] {
  if (!payload || typeof payload !== "object") return [];
  const sessions = (payload as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.filter(isHubSession);
}
