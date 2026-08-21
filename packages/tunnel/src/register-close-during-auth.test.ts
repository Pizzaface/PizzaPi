import { describe, expect, test } from "bun:test";
import { TunnelRelay } from "./server.js";

type Listener = (event?: unknown) => void;

function createMockWebSocket() {
  const sent: string[] = [];
  let closed = false;
  let readyState = WebSocket.OPEN;
  const listeners = new Map<string, Listener[]>();

  const ws = {
    get readyState() {
      return readyState;
    },
    send(data: string) {
      sent.push(data);
    },
    close() {
      closed = true;
      readyState = WebSocket.CLOSED;
      for (const listener of listeners.get("close") ?? []) {
        listener();
      }
    },
    addEventListener(event: string, listener: Listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
  } as unknown as WebSocket;

  return {
    ws,
    sent,
    listeners,
    get closed() {
      return closed;
    },
    emit(event: string, payload?: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
  };
}

async function waitForMicrotask(): Promise<void> {
  await Promise.resolve();
}

describe("TunnelRelay registration close/error race", () => {
  test("does not keep a ghost runner when the socket closes during async authorization", async () => {
    let resolveAuth: ((value: string | null) => void) | undefined;
    const authPromise = new Promise<string | null>((resolve) => {
      resolveAuth = resolve;
    });

    const relay = new TunnelRelay({
      apiKeys: async () => authPromise,
    });

    const mock = createMockWebSocket();
    relay.handleConnection(mock.ws);

    mock.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "ghost", apiKey: "k" }),
    });

    // Let handleMessage reach the awaited authorizeApiKey call.
    await waitForMicrotask();

    // The socket drops (client abort / network blip) before auth resolves.
    mock.ws.close();
    await waitForMicrotask();

    // Authorization finally completes against a dead socket.
    resolveAuth!("default");
    await waitForMicrotask();

    // The relay must not advertise the runner as connected.
    expect(relay.hasRunner("ghost")).toBe(false);
  });

  test("does not keep a ghost runner when the socket errors and closes during async authorization", async () => {
    let resolveAuth: ((value: string | null) => void) | undefined;
    const authPromise = new Promise<string | null>((resolve) => {
      resolveAuth = resolve;
    });

    const relay = new TunnelRelay({
      apiKeys: async () => authPromise,
    });

    const mock = createMockWebSocket();
    relay.handleConnection(mock.ws);

    mock.emit("message", {
      data: JSON.stringify({ type: "register", runnerId: "ghost-err", apiKey: "k" }),
    });

    await waitForMicrotask();

    // An error event arrives and the socket closes before authorize completes.
    mock.emit("error");
    mock.ws.close();
    await waitForMicrotask();

    resolveAuth!("default");
    await waitForMicrotask();

    expect(relay.hasRunner("ghost-err")).toBe(false);
  });
});
