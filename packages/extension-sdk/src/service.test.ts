import { describe, expect, test } from "bun:test";
import type { PizzaPiSocket, ServiceHandler, ServiceInitOptions } from "./service.js";

describe("public service contract", () => {
  test("a typed handler works against a plain event-emitter socket", () => {
    const listeners = new Map<string, (args: unknown[]) => void>();
    const socket: PizzaPiSocket = {
      on<Args extends unknown[]>(event: string, listener: (...args: Args) => void) {
        listeners.set(event, (args) => listener(...(args as Args)));
        return socket;
      },
      off(event) {
        listeners.delete(event);
        return socket;
      },
      emit(event, ...args) {
        listeners.get(event)?.(args);
        return true;
      },
    };

    let initialized = false;
    let disposed = false;
    let endedSession: string | undefined;
    const handler: ServiceHandler = {
      id: "example",
      init(sock, options: ServiceInitOptions) {
        initialized = true;
        sock.on("ping", (message: string) => sock.emit("pong", message.length));
        expect(options.isShuttingDown()).toBe(false);
      },
      dispose() {
        disposed = true;
      },
      handleSessionEnded(sessionId) {
        endedSession = sessionId;
      },
    };

    handler.init(socket, { isShuttingDown: () => false });
    expect(initialized).toBe(true);

    let pong = 0;
    socket.on("pong", (length: number) => (pong = length));
    socket.emit("ping", "hello");
    expect(pong).toBe(5);

    handler.handleSessionEnded?.("session-1");
    expect(endedSession).toBe("session-1");

    handler.dispose();
    expect(disposed).toBe(true);
  });
});
