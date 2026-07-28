import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, test, expect } from "bun:test";
import { wrapProviderAsExtension } from "./pi-bridge-adapter.js";
import type { ExtensionProvider } from "../../providers/types.js";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

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
    await handlers.get("session_shutdown")?.({ reason: "quit", targetSessionFile: undefined }, makeCtx());

    expect(order).toEqual(["shutdown", "dispose"]);
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
    const start = Date.now();
    const result = await handlers.get("before_agent_start")?.(
      { prompt: "hi", systemPrompt: "BASE" },
      makeCtx(),
    );
    const elapsed = Date.now() - start;

    // Timed out and swallowed by the bridge -> no contributions -> no return value.
    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(1000);
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
    for (let i = 0; i < 5; i++) {
      await handlers.get("before_agent_start")?.({ prompt: `p${i}`, systemPrompt: "BASE" }, makeCtx());
    }

    // Bridge disables the provider after the 3rd consecutive error, so calls
    // 4 and 5 never reach the provider hook.
    expect(calls).toBe(3);
  });
});
