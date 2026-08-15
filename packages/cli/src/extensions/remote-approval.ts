/**
 * Extension-driven approvals for the remote extension.
 *
 * pi's `tool_call` event lets an extension block a tool before it runs, but the
 * headless worker has no way to ask the *web UI* for a decision — pi's
 * `ui.confirm/select/input` are stubbed here. This module provides that missing
 * round-trip, mirroring the AskUserQuestion / plan_mode pending-prompt pattern:
 * emit an `approval_pending` meta-event, block, and resolve when the web UI
 * posts the decision back over the input channel.
 *
 * Two front doors funnel into one engine (`requestApprovalViaWeb`):
 *   1. pi's standard `ctx.ui.confirm/select/input` (wired in worker.ts via the
 *      module ref below), and
 *   2. the `requestApproval()` primitive in @pizzapi/extension-sdk, which any
 *      package extension can call — delivered here over pi's event bus.
 */

import { randomUUID } from "node:crypto";
import type { ApprovalRequest, ApprovalDecision, MetaPendingApproval } from "@pizzapi/protocol";
import type { RelayContext } from "./remote-types.js";
import { emitApprovalPending, emitApprovalCleared } from "./remote-meta-events.js";

// ── Module ref: lets worker.ts reach the (later-created) round-trip ──────────
// worker.ts builds the uiContext during boot, before RelayContext exists, so it
// reads the handler lazily at call time.

type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;
let currentHandler: ApprovalHandler | null = null;

export function setApprovalHandler(handler: ApprovalHandler): void {
  currentHandler = handler;
}
export function clearApprovalHandler(handler: ApprovalHandler): void {
  if (currentHandler === handler) currentHandler = null;
}
export function getApprovalHandler(): ApprovalHandler | null {
  return currentHandler;
}

const UNAVAILABLE: ApprovalDecision = { action: "unavailable", approved: false, unavailable: true };

/** Strip a request down to the fields the web card needs, with sane defaults. */
function toMetaApproval(promptId: string, request: ApprovalRequest): MetaPendingApproval {
  const fields = Array.isArray(request.fields)
    ? request.fields
        .filter((f) => f && typeof f.key === "string" && typeof f.label === "string")
        .map((f) => ({
          key: f.key,
          label: f.label,
          value: typeof f.value === "string" ? f.value : String(f.value ?? ""),
          editable: f.editable === true,
          multiline: f.multiline === true,
        }))
    : undefined;
  const actions = Array.isArray(request.actions) && request.actions.length > 0
    ? request.actions
        .filter((a) => a && typeof a.id === "string" && typeof a.label === "string")
        .map((a) => ({ id: a.id, label: a.label, style: a.style }))
    : undefined;
  return {
    promptId,
    title: typeof request.title === "string" && request.title.trim() ? request.title.trim() : "Approve action?",
    message: typeof request.message === "string" ? request.message : undefined,
    toolName: typeof request.toolName === "string" ? request.toolName : undefined,
    icon: typeof request.icon === "string" ? request.icon : undefined,
    ...(fields && fields.length > 0 ? { fields } : {}),
    ...(actions ? { actions } : {}),
  };
}

/**
 * Ask the web UI to decide on `request`. Resolves with the decision, or a
 * fail-closed reject on abort. Returns `null` when no web viewer is connected
 * so callers can fall back (e.g. treat as unavailable).
 */
export async function requestApprovalViaWeb(
  rctx: RelayContext,
  request: ApprovalRequest,
  signal?: AbortSignal,
): Promise<ApprovalDecision | null> {
  if (!rctx.isConnected()) return null;

  const promptId = randomUUID();

  return await new Promise<ApprovalDecision>((resolve) => {
    let finished = false;

    const finish = (decision: ApprovalDecision) => {
      if (finished) return;
      finished = true;
      if (rctx.pendingApproval?.promptId === promptId) {
        rctx.pendingApproval = null;
        emitApprovalCleared(rctx, promptId);
      }
      if (signal) signal.removeEventListener("abort", onAbort);
      rctx.setRelayStatus(rctx.relay ? "Connected to Relay" : rctx.disconnectedStatusText());
      resolve(decision);
    };

    // Abort (turn cancelled) fails closed — never approve a gated action just
    // because the run was interrupted.
    const onAbort = () => finish({ action: "reject", approved: false });

    if (signal?.aborted) {
      finish({ action: "reject", approved: false });
      return;
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    rctx.pendingApproval = {
      promptId,
      resolve: (decision) => finish(decision ?? { action: "reject", approved: false }),
    };
    emitApprovalPending(rctx, toMetaApproval(promptId, request));
    rctx.setRelayStatus("Waiting for approval");
  });
}

/**
 * Consume a decision posted from the web UI over the input channel.
 *
 * Strict: only claims the message when it parses to a decision object with a
 * string `action`, so a normal user message typed while an approval is pending
 * is not swallowed.
 */
export function consumePendingApprovalFromWeb(rctx: RelayContext, text: string): boolean {
  if (!rctx.pendingApproval) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed[0] !== "{") return false;

  let decision: ApprovalDecision | null = null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && typeof parsed.action === "string") {
      // Optional promptId guard: ignore a stale decision for a different prompt.
      if (typeof parsed.promptId === "string" && parsed.promptId !== rctx.pendingApproval.promptId) {
        return false;
      }
      const edits =
        parsed.edits && typeof parsed.edits === "object" && !Array.isArray(parsed.edits)
          ? (Object.fromEntries(
              Object.entries(parsed.edits as Record<string, unknown>)
                .filter(([, v]) => typeof v === "string")
                .map(([k, v]) => [k, v as string]),
            ) as Record<string, string>)
          : undefined;
      decision = {
        action: parsed.action,
        approved: parsed.action === "approve",
        ...(edits && Object.keys(edits).length > 0 ? { edits } : {}),
      };
    }
  } catch {
    return false;
  }
  if (!decision) return false;

  const pending = rctx.pendingApproval;
  rctx.pendingApproval = null;
  emitApprovalCleared(rctx, pending.promptId);
  pending.resolve(decision);
  rctx.setRelayStatus(rctx.relay ? "Connected to Relay" : rctx.disconnectedStatusText());
  return true;
}

export function cancelPendingApproval(rctx: RelayContext): void {
  if (!rctx.pendingApproval) return;
  const pending = rctx.pendingApproval;
  rctx.pendingApproval = null;
  emitApprovalCleared(rctx, pending.promptId);
  // Fail closed on cancellation (disconnect / shutdown).
  pending.resolve({ action: "reject", approved: false });
  rctx.setRelayStatus(rctx.relay ? "Connected to Relay" : rctx.disconnectedStatusText());
}

/**
 * Wire the approval engine into the process:
 *  - publish the handler for worker.ts's `ui.confirm/select/input`, and
 *  - listen on pi's event bus for `requestApproval()` calls from package
 *    extensions (@pizzapi/extension-sdk).
 *
 * Returns a disposer that removes both.
 */
export function registerApprovalBridge(rctx: RelayContext): () => void {
  const handler: ApprovalHandler = async (request) => {
    const decision = await requestApprovalViaWeb(rctx, request);
    return decision ?? UNAVAILABLE;
  };
  setApprovalHandler(handler);

  const events = (rctx.pi as { events?: { on(e: string, h: (p: unknown) => void): () => void } }).events;
  let offBus = () => {};
  if (events?.on) {
    offBus = events.on("pizzapi:approval:request", (payload: unknown) => {
      const p = payload as { request?: ApprovalRequest; respond?: (d: ApprovalDecision) => void } | null;
      if (!p || typeof p.respond !== "function" || !p.request) return;
      const respond = p.respond;
      void handler(p.request)
        .then((decision) => respond(decision))
        .catch(() => respond(UNAVAILABLE));
    });
  }

  return () => {
    clearApprovalHandler(handler);
    try { offBus(); } catch { /* bus already torn down */ }
  };
}
