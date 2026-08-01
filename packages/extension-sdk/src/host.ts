import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface PizzaPiHostInfo {
  apiVersion: 1;
  capabilities: readonly string[];
}

export type PizzaPiHostAPI = Pick<ExtensionAPI, "events">;

export function isPizzaPiHostInfo(value: unknown): value is PizzaPiHostInfo {
  if (!value || typeof value !== "object") return false;
  const host = value as Record<string, unknown>;
  return (
    host.apiVersion === 1 &&
    Array.isArray(host.capabilities) &&
    host.capabilities.every((item) => typeof item === "string")
  );
}

/**
 * Synchronous host probe. The PizzaPi host's `pizzapi:host:probe` listener
 * (if present) must respond synchronously — pi's event bus dispatches
 * listeners synchronously before `emit()` returns, but only the first
 * synchronous tick of an async listener runs before then.
 */
export function detectPizzaPiHost(pi: PizzaPiHostAPI): PizzaPiHostInfo | undefined {
  let host: PizzaPiHostInfo | undefined;
  pi.events.emit("pizzapi:host:probe", {
    respond(value: unknown) {
      if (!host && isPizzaPiHostInfo(value)) host = value;
    },
  });
  return host;
}

/**
 * Subscribes to host readiness. Delivers immediately if the host already
 * responded to a synchronous probe, otherwise waits for the host's
 * `pizzapi:host:ready` announcement. Delivers at most once.
 */
export function onPizzaPiHost(pi: PizzaPiHostAPI, callback: (host: PizzaPiHostInfo) => void): () => void {
  let delivered = false;
  let unsubscribe = () => {};
  const deliver = (host: PizzaPiHostInfo) => {
    if (delivered) return;
    delivered = true;
    unsubscribe();
    callback(host);
  };
  unsubscribe = pi.events.on("pizzapi:host:ready", (data: unknown) => {
    if (isPizzaPiHostInfo(data)) deliver(data);
  });
  const current = detectPizzaPiHost(pi);
  if (current) deliver(current);
  return unsubscribe;
}
