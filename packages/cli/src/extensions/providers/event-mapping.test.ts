import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, test, expect } from "bun:test";
import { wrapProviderAsExtension } from "./pi-bridge-adapter.js";
import type { ExtensionProvider } from "../../providers/types.js";

/**
 * Exhaustive provider-hook <-> pi-event mapping table exercised by this file.
 * Keep in sync with the doc comment on wrapProviderAsExtension().
 *
 * | Provider hook          | pi event            | Argument translation                                   |
 * |-------------------------|----------------------|----------------------------------------------------------|
 * | init()                  | session_start        | ProviderInitContext synthesized (config: {}, socket: null, fireTrigger/publishMetadata no-ops) |
 * | onSessionStart           | session_start         | { reason, previousSessionFile } passed through            |
 * | onBeforeAgentStart        | before_agent_start     | { prompt, images, systemPrompt } in; ContextContribution[] out mapped to pi's { systemPrompt } |
 * | onTurnEnd                 | turn_end               | pi's toolResults[].{toolName,content,details,isError} -> provider's {name,output,isError} |
 * | onSessionShutdown          | session_shutdown        | { reason, targetSessionFile } passed through               |
 * | dispose()                  | session_shutdown        | called after onSessionShutdown                             |
 * | onSessionClose              | (none)                   | NO PI EQUIVALENT — never invoked by this adapter            |
 */

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

function makeFakeApi() {
  const handlers = new Map<string, Handler>();
  const api = { on: (event: string, handler: Handler) => { handlers.set(event, handler); } } as unknown as ExtensionAPI;
  return { api, handlers };
}

function makeCtx() {
  return {
    cwd: "/tmp/proj",
    signal: new AbortController().signal,
    sessionManager: { getSessionFile: () => "s.json" },
  };
}

function makeProvider(overrides: Record<string, any> = {}): ExtensionProvider {
  return {
    id: "mapping-provider",
    capabilities: ["context", "lifecycle"] as const,
    init: async () => {},
    dispose: async () => {},
    ...overrides,
  } as ExtensionProvider;
}

async function install(provider: ExtensionProvider) {
  const { api, handlers } = makeFakeApi();
  await wrapProviderAsExtension(provider)(api);
  return handlers;
}

describe("event mapping table", () => {
  test("only maps the four pi events with native ExtensionProvider equivalents", async () => {
    const handlers = await install(makeProvider());
    expect(Array.from(handlers.keys()).sort()).toEqual(
      ["before_agent_start", "session_shutdown", "session_start", "turn_end"].sort(),
    );
  });

  test("session_start -> init() ProviderInitContext shape", async () => {
    let seen: any;
    const handlers = await install(makeProvider({ init: async (ctx: unknown) => { seen = ctx; } }));
    await handlers.get("session_start")?.({ reason: "new" }, makeCtx());

    expect(seen.config).toEqual({});
    expect(seen.socket).toBeNull();
    expect(typeof seen.fireTrigger).toBe("function");
    expect(typeof seen.publishMetadata).toBe("function");
    await expect(seen.fireTrigger("s", "t", {})).resolves.toBeUndefined();
    expect(seen.publishMetadata("s", {})).toBeUndefined();
  });

  test("session_start -> onSessionStart({ reason, previousSessionFile })", async () => {
    let seen: any;
    const handlers = await install(makeProvider({ onSessionStart: async (event: unknown) => { seen = event; } }));
    await handlers.get("session_start")?.({ reason: "resume", previousSessionFile: "old.json" }, makeCtx());
    expect(seen).toEqual({ reason: "resume", previousSessionFile: "old.json" });
  });

  test("before_agent_start -> onBeforeAgentStart({ prompt, images, systemPrompt })", async () => {
    let seen: any;
    const handlers = await install(makeProvider({ onBeforeAgentStart: async (event: unknown) => { seen = event; return []; } }));
    await handlers.get("before_agent_start")?.(
      { prompt: "do a thing", images: [{ type: "image" }], systemPrompt: "SYS" },
      makeCtx(),
    );
    expect(seen).toEqual({ prompt: "do a thing", images: [{ type: "image" }], systemPrompt: "SYS" });
  });

  test("onBeforeAgentStart ContextContribution[] -> pi's { systemPrompt } result", async () => {
    const handlers = await install(makeProvider({
      onBeforeAgentStart: async () => [{ text: "EXTRA", placement: "append", order: 1, summary: "extra" }],
    }));
    const result = await handlers.get("before_agent_start")?.({ prompt: "p", systemPrompt: "BASE" }, makeCtx()) as { systemPrompt: string };
    expect(result).toEqual({ systemPrompt: "BASE\nEXTRA" });
  });

  test("turn_end -> onTurnEnd translates toolResults field names", async () => {
    let seen: any;
    const handlers = await install(makeProvider({ onTurnEnd: async (event: unknown) => { seen = event; } }));
    await handlers.get("turn_end")?.(
      {
        turnIndex: 7,
        message: { role: "assistant", content: "hi" },
        toolResults: [
          { toolName: "read", content: "file contents", isError: false },
          { toolName: "write", details: { path: "/x" }, isError: true },
        ],
      },
      makeCtx(),
    );
    expect(seen).toEqual({
      turnIndex: 7,
      message: { role: "assistant", content: "hi" },
      toolResults: [
        { name: "read", output: JSON.stringify("file contents"), isError: false },
        { name: "write", output: JSON.stringify({ path: "/x" }), isError: true },
      ],
    });
  });

  test("session_shutdown -> onSessionShutdown({ reason, targetSessionFile })", async () => {
    let seen: any;
    const handlers = await install(makeProvider({ onSessionShutdown: async (event: unknown) => { seen = event; } }));
    await handlers.get("session_shutdown")?.({ reason: "reload", targetSessionFile: "next.json" }, makeCtx());
    expect(seen).toEqual({ reason: "reload", targetSessionFile: "next.json" });
  });

  test("session_shutdown -> dispose() runs after onSessionShutdown", async () => {
    const order: string[] = [];
    const handlers = await install(makeProvider({
      onSessionShutdown: async () => { order.push("onSessionShutdown"); },
      dispose: async () => { order.push("dispose"); },
    }));
    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx());
    expect(order).toEqual(["onSessionShutdown", "dispose"]);
  });

  test("onSessionClose has no pi equivalent and is never invoked", async () => {
    let closeCalled = false;
    const handlers = await install(makeProvider({
      onSessionClose: async () => { closeCalled = true; return { label: "l", jobRef: {} }; },
    }));

    // Fire every mapped event; onSessionClose must never fire regardless.
    await handlers.get("session_start")?.({ reason: "startup" }, makeCtx());
    await handlers.get("before_agent_start")?.({ prompt: "p", systemPrompt: "s" }, makeCtx());
    await handlers.get("turn_end")?.({ turnIndex: 0, message: { role: "assistant", content: "" }, toolResults: [] }, makeCtx());
    await handlers.get("session_shutdown")?.({ reason: "quit" }, makeCtx());

    expect(closeCalled).toBe(false);
  });
});
