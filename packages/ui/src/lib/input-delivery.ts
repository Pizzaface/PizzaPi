interface AckSocketLifecycle {
  once: (event: "disconnect", listener: () => void) => unknown;
  off: (event: "disconnect", listener: () => void) => unknown;
}

/**
 * Emit viewer input and wait for an explicit acknowledgement when supported.
 * Old servers consume the input but never invoke the callback, so an ack timeout
 * is treated as success. Explicit false, disconnect, and synchronous failures
 * remain failures.
 */
export function emitInputWithAck(
  socket: AckSocketLifecycle,
  payload: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onDisconnect = () => settle(false);
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      socket.off("disconnect", onDisconnect);
      resolve(value === true);
    };

    timeout = setTimeout(() => settle(true), timeoutMs);
    socket.once("disconnect", onDisconnect);
    try {
      (socket as unknown as { emit: (...args: unknown[]) => unknown })
        .emit("input", payload, (value: boolean) => settle(value));
    } catch {
      settle(false);
    }
  });
}
