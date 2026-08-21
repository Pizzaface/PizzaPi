import { describe, expect, mock, test } from "bun:test";
import { emitInputWithAck } from "./input-delivery";

function socketWithEmit(emit: (...args: unknown[]) => unknown) {
  return {
    emit: mock(emit),
    once: mock(() => undefined),
    off: mock(() => undefined),
  };
}

describe("emitInputWithAck", () => {
  test("returns an explicit acknowledgement and clears its timeout", async () => {
    const socket = socketWithEmit((...args) => {
      (args[2] as (delivered: boolean) => void)(true);
    });

    expect(await emitInputWithAck(socket, { text: "hello", requestId: "req-1" }, 20)).toBe(true);
    expect(socket.off).toHaveBeenCalledTimes(1);
  });

  test("reports an explicit delivery failure", async () => {
    const socket = socketWithEmit((...args) => {
      (args[2] as (delivered: boolean) => void)(false);
    });

    expect(await emitInputWithAck(socket, { text: "hello" }, 20)).toBe(false);
  });

  test("treats a missing acknowledgement from an old server as delivered", async () => {
    const socket = socketWithEmit(() => undefined);

    expect(await emitInputWithAck(socket, { text: "legacy" }, 5)).toBe(true);
  });
});
