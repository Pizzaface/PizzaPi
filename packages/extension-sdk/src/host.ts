import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequest, ApprovalDecision } from "@pizzapi/protocol";

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
 * Send a message from a session-side package extension to a daemon-scoped
 * runner service, as a `service_message` envelope on the relay socket.
 *
 * This is the outbound half of any bridge whose service lives in the daemon
 * (chat connectors, dashboards, notifiers): services see none of a session's
 * in-process events, so the package ships an extension that observes them and
 * forwards what it needs over this channel.
 *
 * The host stamps a unique top-level `id` (for at-least-once dedupe, `env.id`)
 * and the relay stamps the top-level `sessionId` from the authenticated
 * socket. No-op when there is no PizzaPi host, or when the relay
 * socket is mid-reconnect — a dropped message must never block a turn.
 */
export function sendServiceMessage(
  pi: PizzaPiHostAPI,
  serviceId: string,
  type: string,
  payload?: Record<string, unknown>,
): void {
  pi.events.emit("pizzapi:service_message", { serviceId, type, payload: payload ?? {} });
}

const UNAVAILABLE: ApprovalDecision = { action: "unavailable", approved: false, unavailable: true };

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return !!value && typeof value === "object" && typeof (value as { action?: unknown }).action === "string";
}

/**
 * Ask the user to approve an action before it runs, and wait for the decision.
 *
 * The intended use is inside a pi `tool_call` handler: gate a high-stakes tool
 * (send email, create event, purchase) by presenting an approval card in the
 * web UI, then `block` the tool when the user rejects. Because pi refuses to
 * run a blocked tool, this is real enforcement, not a cooperative convention.
 *
 * Resolves with `{ unavailable: true }` when no PizzaPi host / web viewer can
 * render the approval (headless, disconnected) so the caller decides how to
 * fail — a security-sensitive gate should treat `unavailable` as "do not run".
 */
export function requestApproval(pi: PizzaPiHostAPI, request: ApprovalRequest): Promise<ApprovalDecision> {
  if (!detectPizzaPiHost(pi)) return Promise.resolve(UNAVAILABLE);
  return new Promise<ApprovalDecision>((resolve) => {
    let settled = false;
    const settle = (decision: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      resolve(decision);
    };
    pi.events.emit("pizzapi:approval:request", {
      request,
      respond(decision: unknown) {
        settle(isApprovalDecision(decision) ? decision : UNAVAILABLE);
      },
    });
  });
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
