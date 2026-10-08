// ============================================================================
// Regression test for the MCP OAuth relay-anchor self-abort bug (GM xfOp6Cbn):
//
// session_start captures `lifecycleAtStart` and only fires
// markOAuthRelayWaitAnchorReady() once waitForRelayRegistration() resolves
// AND `lifecycleAtStart.signal` is not aborted. That guard exists so a slow
// relay registration from a shut-down session N doesn't leak the anchor
// callback into session N+1.
//
// The bug: `lifecycleAtStart` used to be captured from `loadLifecycleController`
// — the same controller that load() unconditionally aborts and replaces on
// *every* call, including the very retry load() the session_start handler
// performs right after capturing it. So a session_start that needed the
// eager-failed retry path self-aborted its own anchor guard before the relay
// ever finished registering, and markOAuthRelayWaitAnchorReady() never fired
// — reproducing the headless-auth 15s-fallback regression the guard was
// written to prevent.
//
// Fix: the relay-anchor guard is tied to a separate `sessionLifecycleController`
// that load() never touches; only session_shutdown retires it.
// ============================================================================

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setGlobalConfigDir } from "../config/io.js";

// Controllable waitForRelayRegistration(): resolved manually by the test so
// we can simulate relay registration completing *after* session_start's
// retry load() has already run and recycled loadLifecycleController.
let resolveRelayRegistration: (() => void) | null = null;
mock.module("./remote.js", () => ({
  waitForRelayRegistration: mock(
    () =>
      new Promise<void>((resolve) => {
        resolveRelayRegistration = resolve;
      }),
  ),
}));

const markOAuthRelayWaitAnchorReady = mock(() => {});
const setDeferOAuthRelayWaitTimeoutUntilAnchor = mock(() => {});

// The eager load fails (simulating a startup race/handshake failure) so
// session_start takes the "eager-failed retry" path and calls load()
// directly — the exact path that used to self-abort the anchor guard.
let registerMcpToolsCallCount = 0;
mock.module("./mcp.js", () => ({
  registerMcpTools: mock(async () => {
    registerMcpToolsCallCount++;
    if (registerMcpToolsCallCount === 1) {
      throw new Error("simulated eager init failure");
    }
    return {
      clients: [],
      toolNames: [],
      serverTools: {},
      errors: [],
      toolCount: 0,
      serverTimings: [],
      totalDurationMs: 0,
    };
  }),
  collectDisabledMcpServers: mock(() => []),
  getOAuthProviders: mock(() => []),
  setDeferOAuthRelayWaitTimeoutUntilAnchor,
  markOAuthRelayWaitAnchorReady,
}));

const { mcpExtension } = await import("./mcp-extension.js");

type Handler = (event: any, ctx: any) => unknown;

function makeFakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi: any = {
    on: mock((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    events: { on: mock(() => {}), emit: mock(() => {}) },
    registerCommand: mock(() => {}),
    getActiveTools: mock(() => []),
    setActiveTools: mock(() => {}),
  };
  return {
    pi,
    async fire(event: string, payload: any = {}, ctx: any = {}) {
      for (const h of handlers.get(event) ?? []) await h(payload, ctx);
    },
  };
}

describe("mcp-extension session lifecycle — relay-anchor guard (GM xfOp6Cbn)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    registerMcpToolsCallCount = 0;
    resolveRelayRegistration = null;
    markOAuthRelayWaitAnchorReady.mockClear();
    setDeferOAuthRelayWaitTimeoutUntilAnchor.mockClear();
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-mcpext-lifecycle-"));
    process.chdir(tmpDir);
    _setGlobalConfigDir(join(tmpDir, "global-config"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    _setGlobalConfigDir(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("a slow relay registration still fires markOAuthRelayWaitAnchorReady after session_start's eager-failed retry load()", async () => {
    const { pi, fire } = makeFakePi();
    await mcpExtension(pi);

    await fire("session_start");

    // Eager load failed (call #1), session_start retried with its own
    // load() (call #2) — the exact sequence that used to recycle
    // loadLifecycleController and self-abort the anchor guard.
    expect(registerMcpToolsCallCount).toBe(2);
    expect(resolveRelayRegistration).not.toBeNull();

    // Relay registration only resolves now, after the retry load() already
    // ran. The anchor callback must still fire.
    resolveRelayRegistration!();
    await Promise.resolve();
    await Promise.resolve();

    expect(markOAuthRelayWaitAnchorReady).toHaveBeenCalledTimes(1);
  });
});
