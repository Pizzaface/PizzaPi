/**
 * Model selection from web — handles model_set events from the relay.
 *
 * Extracted from remote/index.ts.
 */

import type { RelayContext } from "../remote-types.js";
import { emitModelChanged, emitAuthSourceChanged } from "../remote-meta-events.js";
import { getAuthSource } from "../remote-auth-source.js";
import { emitSessionActive } from "./chunked-delivery.js";

/**
 * Handle a web-initiated model change request.
 * Looks up the model in the registry, calls pi.setModel, and forwards the
 * result back to relay viewers via forwardEvent.
 */
export async function setModelFromWeb(
    rctx: RelayContext,
    pi: any,
    provider: string,
    modelId: string,
): Promise<void> {
    if (!rctx.latestCtx) return;

    const model = rctx.latestCtx.modelRegistry.find(provider, modelId);
    if (!model) {
        rctx.forwardEvent({
            type: "model_set_result",
            ok: false,
            provider,
            modelId,
            message: "Model is not configured for this session.",
        });
        return;
    }

    try {
        const ok = await (pi as any).setModel(model);
        rctx.forwardEvent({
            type: "model_set_result",
            ok,
            provider,
            modelId,
            message: ok ? undefined : "Model selected, but no valid credentials were found.",
        });
        if (ok) {
            emitModelChanged(
                rctx,
                rctx.latestCtx?.model
                    ? {
                          provider: rctx.latestCtx.model.provider,
                          id: rctx.latestCtx.model.id,
                          name: rctx.latestCtx.model.name,
                          reasoning: rctx.latestCtx.model.reasoning,
                          contextWindow: rctx.latestCtx.model.contextWindow,
                      }
                    : null,
            );
            emitAuthSourceChanged(rctx, getAuthSource(rctx.latestCtx));
            emitSessionActive(rctx);
        }
    } catch (error) {
        rctx.forwardEvent({
            type: "model_set_result",
            ok: false,
            provider,
            modelId,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}
