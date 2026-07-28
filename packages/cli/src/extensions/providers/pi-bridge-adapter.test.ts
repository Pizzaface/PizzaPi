import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, test, expect } from "bun:test";
import { wrapProviderAsExtension } from "./pi-bridge-adapter.js";
import type { ExtensionProvider } from "../../providers/types.js";

type Handler = (event: any, ctx: any) => Promise<unknown>;

function makeFakeApi() {
  const handlers = new Map<string, Handler>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/project",
    signal: new AbortController().signal,
    sessionManager: { getSessionFile: () => "session-abc.json" },
    ...overrides,
  };
}

function makeProvider(overrides: Record<string, any> = {}): ExtensionProvider {
  return {
    id: "mock-provider",
    capabilities: ["context", "lifecycle"] as const,
    init: async () => {},
    dispose: async () => {},
    ...overrides,
  } as ExtensionProvider;
}

async function install(provider: ExtensionProvider, opts?: { timeoutMs?: number }) {
  const { api, handlers } = makeFakeApi();
  await wrapProviderAsExtension(provider, opts)(api);
  return handlers;
}

describe("wrapProviderAsExtension", () => {
  test("session_start calls provider.init() once and onSessionStart with mapped args", async () => {
    const initCalls: unknown[] = [];
    const startCalls: unknown[] = [];
    const provider = makeProvider({
      init: async (ctx: unknown) => { initCalls.push(ctx); },
      onSessionStart: async (event: unknown) => { startCalls.push(event); },
    });

    const handlers = await install(provider);
    await handlers.get("session_start")?.(
      { reason: "startup", previousSessionFile: "prev.json" },
      makeCtx(),
    );

    expect(initCalls.length).toBe(1);
    expect(initCalls[0]).toMatchObject({ config: {}, socket: null });
    expect(typeof (initCalls[0] as any).fireTrigger).toBe("function");
    expect(typeof (initCalls[0] as any).publishMetadata).toBe("function");

    expect(startCalls).toEqual([{ reason: "startup", previousSessionFile: "prev.json" }]);

    // A second session_start must not re-init.
    await handlers.get("session_start")?.({ reason: "reload" }, makeCtx());
    expect(initCalls.length).toBe(1);
    expect(startCalls.length).toBe(2);
  });

  test("before_agent_start calls onBeforeAgentStart and maps contributions onto { systemPrompt }", async () => {
    const calls: unknown[] = [];
    const provider = makeProvider({
      onBeforeAgentStart: async (event: unknown) => {
        calls.push(event);
        return [
          { text: "PRE", placement: "prepend", order: 50, summary: "pre" },
          { text: "POST", placement: "append", order: 50, summary: "post" },
        ];
      },
    });

    const handlers = await install(provider);
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());
    const result = await handlers.get("before_agent_start")?.(
      { prompt: "hello", images: [], systemPrompt: "BASE" },
      makeCtx(),
    ) as { systemPrompt: string };

    expect(calls).toEqual([{ prompt: "hello", images: [], systemPrompt: "BASE" }]);
    expect(result.systemPrompt).toBe("PRE\nBASE\nPOST");
  });

  test("turn_end maps pi's toolResults onto the provider's TurnEndEvent shape", async () => {
    const calls: unknown[] = [];
    const provider = makeProvider({
      onTurnEnd: async (event: unknown) => { calls.push(event); },
    });

    const handlers = await install(provider);
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());
    await handlers.get("turn_end")?.(
      {
        turnIndex: 3,
        message: { role: "assistant", content: "done" },
        toolResults: [{ toolName: "bash", content: { ok: true }, isError: false }],
      },
      makeCtx(),
    );

    expect(calls).toEqual([{
      turnIndex: 3,
      message: { role: "assistant", content: "done" },
      toolResults: [{ name: "bash", output: JSON.stringify({ ok: true }), isError: false }],
    }]);
  });

  test("session_shutdown calls onSessionShutdown then provider.dispose()", async () => {
    const order: string[] = [];
    const provider = makeProvider({
      onSessionShutdown: async () => { order.push("shutdown"); },
      dispose: async () => { order.push("dispose"); },
    });

    const handlers = await install(provider);
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());
    await handlers.get("session_shutdown")?.({ reason: "quit", targetSessionFile: undefined }, makeCtx());

    expect(order).toEqual(["shutdown", "dispose"]);
  });

  test("shutdown cleanup is exception-safe: a throwing dispose() still resets lifecycle state", async () => {
    let initCalls = 0;
    let disposeCalls = 0;
    const provider = makeProvider({
      init: async () => { initCalls++; },
      dispose: async () => { disposeCalls++; throw new Error("dispose boom"); },
    });

    const handlers = await install(provider);
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());
    expect(initCalls).toBe(1);

    // dispose() throws — the handler itself must not throw past this point in
    // a way that leaves stale state; whether the rejection surfaces to the
    // caller or not, the NEXT session_start must re-init rather than skip it.
    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx()).catch(() => {});

    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());
    expect(initCalls).toBe(2);
    expect(disposeCalls).toBe(1);
  });

  test("a shutdown before any session_start is a no-op (does not call dispose)", async () => {
    let disposeCalls = 0;
    const provider = makeProvider({ dispose: async () => { disposeCalls++; } });

    const handlers = await install(provider);
    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx());

    expect(disposeCalls).toBe(0);
  });

  test("two shutdowns in a row only dispose once", async () => {
    let disposeCalls = 0;
    const provider = makeProvider({ dispose: async () => { disposeCalls++; } });

    const handlers = await install(provider);
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());
    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx());
    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx());

    expect(disposeCalls).toBe(1);
  });

  test("two overlapping (concurrent) shutdowns only notify/dispose once each", async () => {
    let shutdownCalls = 0;
    let disposeCalls = 0;
    const provider = makeProvider({
      onSessionShutdown: async () => {
        shutdownCalls++;
        // Yield so a second concurrent invocation has a chance to race in
        // before this one reaches its state-reset.
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      dispose: async () => { disposeCalls++; },
    });

    const handlers = await install(provider);
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());

    const shutdown = handlers.get("session_shutdown")!;
    await Promise.all([
      shutdown({ reason: "quit" }, makeCtx()),
      shutdown({ reason: "quit" }, makeCtx()),
    ]);

    expect(shutdownCalls).toBe(1);
    expect(disposeCalls).toBe(1);
  });

  test("onSessionClose is never called — pi has no equivalent event", async () => {
    let closeCalled = false;
    const provider = makeProvider({
      onSessionClose: async () => { closeCalled = true; return { label: "x", jobRef: {} }; },
    });

    const handlers = await install(provider);
    // Only these four events are ever registered by the adapter.
    expect(Array.from(handlers.keys()).sort()).toEqual(
      ["before_agent_start", "session_shutdown", "session_start", "turn_end"].sort(),
    );

    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());
    await handlers.get("before_agent_start")?.({ prompt: "hi", systemPrompt: "s" }, makeCtx());
    await handlers.get("turn_end")?.({ turnIndex: 0, message: { role: "assistant", content: "" }, toolResults: [] }, makeCtx());
    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx());

    expect(closeCalled).toBe(false);
  });

  test("enforces the configured timeout on a hung provider hook", async () => {
    const provider = makeProvider({
      onBeforeAgentStart: () => new Promise(() => {}), // never resolves
    });

    const handlers = await install(provider, { timeoutMs: 50 });
    // Bridge only exists after session_start — without this, before_agent_start
    // hits the `if (!bridge) return;` guard and the test would pass vacuously
    // (0ms) regardless of whether timeout enforcement exists.
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());

    const start = Date.now();
    const result = await handlers.get("before_agent_start")?.(
      { prompt: "hi", systemPrompt: "BASE" },
      makeCtx(),
    );
    const elapsed = Date.now() - start;

    // Timed out and swallowed by the bridge -> no contributions -> no return value.
    expect(result).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(1000);
  });

  test("propagates an already-aborted signal into the provider hook call", async () => {
    const controller = new AbortController();
    controller.abort();
    // Resolves (does not reject) so an already-settled-but-unraced promise
    // can't trip an unrelated unhandled-rejection warning in the test run.
    const provider = makeProvider({
      onBeforeAgentStart: async () => [{ text: "X", placement: "append", order: 1, summary: "x" }],
    });

    const handlers = await install(provider, { timeoutMs: 200 });
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx({ signal: controller.signal }));
    const result = await handlers.get("before_agent_start")?.(
      { prompt: "hi", systemPrompt: "BASE" },
      makeCtx({ signal: controller.signal }),
    );

    // Aborted before execution -> bridge rejects the call -> no contributions,
    // even though the provider hook itself would have succeeded.
    expect(result).toBeUndefined();
  });

  test("aborting mid-call rejects the in-flight provider hook", async () => {
    const controller = new AbortController();
    const provider = makeProvider({
      onBeforeAgentStart: () => new Promise(() => {}), // never resolves on its own
    });

    const handlers = await install(provider, { timeoutMs: 5000 });
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx({ signal: controller.signal }));

    const start = Date.now();
    const call = handlers.get("before_agent_start")?.(
      { prompt: "hi", systemPrompt: "BASE" },
      makeCtx({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 20);
    const result = await call;
    const elapsed = Date.now() - start;

    // Aborted well before the 5000ms timeout would have fired.
    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(1000);
  });

  test("sorts contributions by order, then providerId, before mapping onto systemPrompt", async () => {
    // Two providers registered directly on a single-provider bridge cannot be
    // exercised through wrapProviderAsExtension (it only wraps one provider),
    // so this drives the sort via multiple contributions from one provider
    // with distinct orders — the bridge sorts the full collected set the same
    // way regardless of provider count.
    const provider = makeProvider({
      onBeforeAgentStart: async () => [
        { text: "THIRD", placement: "append", order: 30, summary: "c" },
        { text: "FIRST", placement: "append", order: 10, summary: "a" },
        { text: "SECOND", placement: "append", order: 20, summary: "b" },
      ],
    });

    const handlers = await install(provider);
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());
    const result = await handlers.get("before_agent_start")?.(
      { prompt: "p", systemPrompt: "BASE" },
      makeCtx(),
    ) as { systemPrompt: string };

    expect(result.systemPrompt).toBe("BASE\nFIRST\nSECOND\nTHIRD");
  });

  test("resets dedupe state on each before_agent_start prompt boundary", async () => {
    let calls = 0;
    const provider = makeProvider({
      onBeforeAgentStart: async () => {
        calls++;
        return [{ text: `CTX-${calls}`, placement: "append", order: 1, summary: "s", dedupeKey: "same-key" }];
      },
    });

    const handlers = await install(provider);
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());

    const first = await handlers.get("before_agent_start")?.(
      { prompt: "p1", systemPrompt: "BASE" },
      makeCtx(),
    ) as { systemPrompt: string };
    expect(first.systemPrompt).toBe("BASE\nCTX-1");

    // A second prompt boundary must re-run the provider and emit fresh text
    // for the same dedupeKey, not silently reuse the first prompt's entry.
    const second = await handlers.get("before_agent_start")?.(
      { prompt: "p2", systemPrompt: "BASE" },
      makeCtx(),
    ) as { systemPrompt: string };
    expect(second.systemPrompt).toBe("BASE\nCTX-2");
    expect(calls).toBe(2);
  });

  test("disables the provider after 3 consecutive errors (delegated to ProviderBridge)", async () => {
    let calls = 0;
    const provider = makeProvider({
      onBeforeAgentStart: async () => {
        calls++;
        throw new Error("boom");
      },
    });

    const handlers = await install(provider, { timeoutMs: 200 });
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());
    for (let i = 0; i < 5; i++) {
      await handlers.get("before_agent_start")?.({ prompt: `p${i}`, systemPrompt: "BASE" }, makeCtx());
    }

    // Bridge disables the provider after the 3rd consecutive error, so calls
    // 4 and 5 never reach the provider hook.
    expect(calls).toBe(3);
  });

  test("disabled-provider state does not leak across sessions (P1 regression)", async () => {
    let calls = 0;
    const provider = makeProvider({
      onBeforeAgentStart: async () => {
        calls++;
        throw new Error("boom");
      },
    });

    const handlers = await install(provider, { timeoutMs: 200 });

    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());

    // 3 consecutive errors disable the provider within this session's bridge.
    for (let i = 0; i < 3; i++) {
      await handlers.get("before_agent_start")?.({ prompt: `p${i}`, systemPrompt: "BASE" }, makeCtx());
    }
    expect(calls).toBe(3);

    // Confirm it's actually disabled: one more call does not reach the provider.
    await handlers.get("before_agent_start")?.({ prompt: "p3", systemPrompt: "BASE" }, makeCtx());
    expect(calls).toBe(3);

    // End the session, then start a new one.
    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx());
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());

    // A fresh session must get a fresh bridge: the provider is invoked again,
    // not permanently disabled from the prior session's error streak.
    await handlers.get("before_agent_start")?.({ prompt: "q0", systemPrompt: "BASE" }, makeCtx());
    expect(calls).toBe(4);
  });
});
