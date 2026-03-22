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

// Inline extraction logic for unit testing (mirrors extractMetaFromHeartbeat)
async function extractFromHeartbeat(sessionId: string, hb: Record<string, unknown>): Promise<void> {
  const patch: Partial<SessionMetaState> = {};
  if (Array.isArray(hb.todoList)) patch.todoList = hb.todoList as SessionMetaState["todoList"];
  if (Object.prototype.hasOwnProperty.call(hb, "pendingQuestion")) {
    patch.pendingQuestion = (hb.pendingQuestion as SessionMetaState["pendingQuestion"]) ?? null;
  }
  if (typeof hb.planModeEnabled === "boolean") patch.planModeEnabled = hb.planModeEnabled;
  if (typeof hb.isCompacting === "boolean") patch.isCompacting = hb.isCompacting;
  if (typeof hb.authSource === "string") patch.authSource = hb.authSource;
  if (Object.keys(patch).length > 0) await updateMetaState(sessionId, patch);
}

describe("extractMetaFromHeartbeat logic", () => {
  beforeEach(() => { sessionStore.clear(); });

  test("extracts todoList from heartbeat", async () => {
    const todos = [{ id: 1, text: "task", status: "pending" as const }];
    await extractFromHeartbeat("s1", { todoList: todos });
    const state = await getMetaState("s1");
    expect(state.todoList).toEqual(todos);
  });

  test("extracts pendingQuestion null (clears it)", async () => {
    await updateMetaState("s1", { pendingQuestion: { toolCallId: "tc1", questions: [] } });
    await extractFromHeartbeat("s1", { pendingQuestion: null });
    const state = await getMetaState("s1");
    expect(state.pendingQuestion).toBeNull();
  });

  test("extracts planModeEnabled", async () => {
    await extractFromHeartbeat("s1", { planModeEnabled: true });
    expect((await getMetaState("s1")).planModeEnabled).toBe(true);
  });

  test("extracts isCompacting", async () => {
    await extractFromHeartbeat("s1", { isCompacting: true });
    expect((await getMetaState("s1")).isCompacting).toBe(true);
  });

  test("skips update when heartbeat has no known meta fields", async () => {
    // No meta fields → no update → version stays at 0
    await extractFromHeartbeat("s1", { active: true, ts: 12345 });
    const state = await getMetaState("s1");
    expect(state.version).toBe(0);
  });

  test("extracts authSource", async () => {
    await extractFromHeartbeat("s1", { authSource: "oauth" });
    expect((await getMetaState("s1")).authSource).toBe("oauth");
  });
});
