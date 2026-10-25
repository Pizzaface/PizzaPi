import * as ort from "onnxruntime-web/wasm";
import { Silero } from "@ricky0123/vad-web/dist/models/silero";
import modelUrl from "@ricky0123/vad-web/dist/silero_vad_v6.onnx?url";
import wasmUrl from "@live-ort/ort-wasm-simd-threaded.wasm?url";
import wasmModuleUrl from "@live-ort/ort-wasm-simd-threaded.mjs?url";

/** All assets are bundled locally; opening Live never fetches a third-party CDN. */
export async function loadSpeechModel(signal?: AbortSignal) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl };
    return Silero.new(ort, async () => {
        const response = await fetch(modelUrl, { signal });
        if (!response.ok) throw new Error(`Speech detector model: HTTP ${response.status}`);
        return response.arrayBuffer();
    });
}
