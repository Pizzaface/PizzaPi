/**
 * Model selection from web — handles model_set events from the relay.
 *
 * Extracted from remote/index.ts.
 */

import type { RelayContext } from "../remote-types.js";
import { getAuthSource } from "../remote-auth-source.js";
import { emitSessionActive } from "./chunked-delivery.js";
import { findCachedOllamaCloudModel } from "../../ollama-cloud-models.js";
import { isModelHidden } from "../../model-visibility.js";

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

    try {
        if (isModelHidden({ provider, id: modelId })) {
            rctx.forwardEvent({
                type: "model_set_result",
                ok: false,
                provider,
                modelId,
                message: "Model is hidden on this runner.",
            });
            return;
        }
        const model =
            rctx.latestCtx.modelRegistry.find(provider, modelId) ??
            findCachedOllamaCloudModel(provider, modelId);
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

        const ok = await (pi as any).setModel(model);
        rctx.forwardEvent({
            type: "model_set_result",
            ok,
            provider,
            modelId,
            message: ok ? undefined : "Model selected, but no valid credentials were found.",
        });
        if (ok) {
            rctx.forwardEvent({
                type: "model_changed",
                model: {
                    provider: model.provider,
                    id: model.id,
                    name: model.name,
                    reasoning: model.reasoning,
                    contextWindow: model.contextWindow,
                },
            });
            rctx.forwardEvent({ type: "auth_source_changed", source: getAuthSource(rctx.latestCtx) });
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

