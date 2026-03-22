// ============================================================================
// meta.ts — Session meta-state registry helpers
//
// Reads and writes the metaState JSON field in the session Redis hash.
// Broadcasts meta events to hub session meta rooms.
// ============================================================================

import { defaultMetaState, type SessionMetaState, type MetaRelayEvent } from "@pizzapi/protocol";
import { getSession, updateSessionFields } from "../sio-state.js";
import { getIo } from "./context.js";

// ── Hub broadcasting ─────────────────────────────────────────────────────────

export function sessionMetaRoom(sessionId: string): string {
  return `session:${sessionId}:meta`;
}

export async function broadcastToSessionMeta(
  sessionId: string,
  event: MetaRelayEvent,
  version: number,
  // Reserved for future per-user room filtering (all session meta rooms are already
  // session-scoped, so userId is not needed for current fan-out logic).
  _userId?: string,
): Promise<void> {
  const io = getIo();
  try {
    const room = sessionMetaRoom(sessionId);
    io.of("/hub").to(room).emit("meta_event", { sessionId, version, ...event });
  } catch (err) {
    console.warn("[meta] broadcastToSessionMeta failed:", (err as Error)?.message);
  }
}

// ── Redis state ──────────────────────────────────────────────────────────────

export async function getSessionMetaState(sessionId: string): Promise<SessionMetaState> {
  const session = await getSession(sessionId);
  if (!session?.metaState) return defaultMetaState();
  try {
    return JSON.parse(session.metaState) as SessionMetaState;
  } catch {
    return defaultMetaState();
  }
}

export async function updateSessionMetaState(
  sessionId: string,
  patch: Partial<SessionMetaState>,
): Promise<number> {
  const current = await getSessionMetaState(sessionId);
  const nextVersion = current.version + 1;
  const next: SessionMetaState = { ...current, ...patch, version: nextVersion };
  await updateSessionFields(sessionId, { metaState: JSON.stringify(next) });
  return nextVersion;
}

export async function extractMetaFromHeartbeat(
  sessionId: string,
  hb: Record<string, unknown>,
): Promise<void> {
  const patch: Partial<SessionMetaState> = {};
  if (Array.isArray(hb.todoList)) patch.todoList = hb.todoList as SessionMetaState["todoList"];
  if (Object.prototype.hasOwnProperty.call(hb, "pendingQuestion")) {
    patch.pendingQuestion = (hb.pendingQuestion as SessionMetaState["pendingQuestion"]) ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(hb, "pendingPlan")) {
    patch.pendingPlan = (hb.pendingPlan as SessionMetaState["pendingPlan"]) ?? null;
  }
  if (typeof hb.planModeEnabled === "boolean") patch.planModeEnabled = hb.planModeEnabled;
  if (typeof hb.isCompacting === "boolean") patch.isCompacting = hb.isCompacting;
  if (Object.prototype.hasOwnProperty.call(hb, "retryState")) {
    patch.retryState = (hb.retryState as SessionMetaState["retryState"]) ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(hb, "pendingPluginTrust")) {
    patch.pendingPluginTrust = (hb.pendingPluginTrust as SessionMetaState["pendingPluginTrust"]) ?? null;
  }
  if (hb.mcpStartupReport && typeof hb.mcpStartupReport === "object") {
    patch.mcpStartupReport = hb.mcpStartupReport as SessionMetaState["mcpStartupReport"];
  }
  if (hb.tokenUsage && typeof hb.tokenUsage === "object") {
    patch.tokenUsage = hb.tokenUsage as SessionMetaState["tokenUsage"];
  }
  if (hb.providerUsage && typeof hb.providerUsage === "object") {
    patch.providerUsage = hb.providerUsage as SessionMetaState["providerUsage"];
  }
  if (Object.prototype.hasOwnProperty.call(hb, "thinkingLevel")) {
    patch.thinkingLevel = typeof hb.thinkingLevel === "string" ? hb.thinkingLevel : null;
  }
  if (typeof hb.authSource === "string") patch.authSource = hb.authSource;
  if (hb.model && typeof hb.model === "object") {
    patch.model = hb.model as SessionMetaState["model"];
  }

  if (Object.keys(patch).length > 0) {
    await updateSessionMetaState(sessionId, patch);
  }
}
