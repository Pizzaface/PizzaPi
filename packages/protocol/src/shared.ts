// ============================================================================
// Shared types used across multiple Socket.IO namespaces
// ============================================================================

/** Information about a connected session, used in hub feed and session lists */
export interface SessionInfo {
  sessionId: string;
  shareUrl: string;
  cwd: string;
  startedAt: string;
  viewerCount?: number;
  userId?: string;
  userName?: string;
  sessionName: string | null;
  isEphemeral: boolean;
  expiresAt?: string | null;
  isActive: boolean;
  lastHeartbeatAt: string | null;
  model: ModelInfo | null;
  runnerId: string | null;
  runnerName: string | null;
}

/** Model provider and identifier */
export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
}

/** Runner daemon metadata */
export interface RunnerInfo {
  runnerId: string;
  name: string | null;
  roots: string[];
  sessionCount: number;
  skills: RunnerSkill[];
  plugins?: RunnerPlugin[];
  version: string | null;
}

/** A discovered Claude Code plugin on a runner */
export interface RunnerPlugin {
  name: string;
  description: string;
  rootPath: string;
  commands: { name: string; description?: string; argumentHint?: string }[];
  hookEvents: string[];
  skills: { name: string; dirPath: string }[];
  rules?: { name: string }[];
  hasMcp: boolean;
  hasAgents: boolean;
  hasLsp: boolean;
  version?: string;
  author?: string;
}

/** A skill available on a runner */
export interface RunnerSkill {
  name: string;
  description: string;
  filePath: string;
}

/** File attachment metadata (used in input messages) */
export interface Attachment {
  attachmentId?: string;
  mediaType?: string;
  filename?: string;
  url?: string;
}
