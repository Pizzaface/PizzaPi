import { describe, test, expect, beforeEach } from "bun:test";
import { defaultMetaState, type SessionMetaState } from "@pizzapi/protocol";

// In-memory session store stub — no Redis needed
const sessionStore = new Map<string, Record<string, unknown>>();

// Inline the meta-state logic for unit testing
async function getMetaState(sessionId: string): Promise<SessionMetaState> {
  const session = sessionStore.get(sessionId);
  if (!session?.metaState) return defaultMetaState();
  try {
    return JSON.parse(session.metaState as string) as SessionMetaState;
  } catch {
    return defaultMetaState();
  }
}

async function updateMetaState(sessionId: string, patch: Partial<SessionMetaState>): Promise<number> {
  const current = await getMetaState(sessionId);
  const nextVersion = current.version + 1;
  const next: SessionMetaState = { ...current, ...patch, version: nextVersion };
  const existing = sessionStore.get(sessionId) ?? {};
  sessionStore.set(sessionId, { ...existing, metaState: JSON.stringify(next) });
  return nextVersion;
}

describe("meta-state helpers (unit)", () => {
  beforeEach(() => { sessionStore.clear(); });

  test("getMetaState returns default for unknown session", async () => {
    const state = await getMetaState("unknown");
    expect(state).toEqual(defaultMetaState());
  });

  test("updateMetaState persists patch", async () => {
    await updateMetaState("s1", { planModeEnabled: true });
    const state = await getMetaState("s1");
    expect(state.planModeEnabled).toBe(true);
  });

  test("updateMetaState increments version on each call", async () => {
    await updateMetaState("s1", { isCompacting: true });
    await updateMetaState("s1", { isCompacting: false });
    const state = await getMetaState("s1");
    expect(state.version).toBe(2);
  });

  test("updateMetaState merges patch preserving other fields", async () => {
    await updateMetaState("s1", { planModeEnabled: true });
    await updateMetaState("s1", { isCompacting: true });
    const state = await getMetaState("s1");
    expect(state.planModeEnabled).toBe(true);
    expect(state.isCompacting).toBe(true);
  });

  test("corrupted metaState falls back to default", async () => {
    sessionStore.set("s1", { metaState: "not-json" });
    const state = await getMetaState("s1");
    expect(state).toEqual(defaultMetaState());
  });

  test("updateMetaState returns new version number", async () => {
    const v1 = await updateMetaState("s1", { planModeEnabled: true });
    expect(v1).toBe(1);
    const v2 = await updateMetaState("s1", { isCompacting: true });
    expect(v2).toBe(2);
  });
});
