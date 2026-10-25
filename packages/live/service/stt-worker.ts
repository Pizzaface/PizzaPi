/**
 * Moonshine streaming STT, in a child process of the runner (see stt.ts). The
 * WASM calls are synchronous (a pass takes ~50–200 ms), so they must not run on
 * the daemon's event loop. Messages are handled strictly in arrival order, so
 * an `end` always sees every audio frame posted before it, and a stream opened
 * during a (re)load waits for the model.
 */
import { readFileSync } from "node:fs";
import type { Stream, Transcriber } from "@moonshine-ai/moonshine-wasm";
import { ensureModelFiles, type Manifest } from "./moonshine-models.ts";
import type { HostToWorker, WorkerToHost } from "./stt.ts";

const post = (m: WorkerToHost) => void process.send?.(m);
let transcriber: Transcriber | null = null;
const streams = new Map<number, { stream: Stream; text: string }>();

const joinLines = (t: { lines: readonly { text: string }[] }) =>
    t.lines.map((l) => l.text.trim()).filter(Boolean).join(" ");

function close(id: number) {
    const s = streams.get(id);
    if (!s) return;
    streams.delete(id);
    try {
        s.stream.close();
    } catch {
        /* already gone */
    }
}

/** The threaded WASM build starts one pthread per reported core; bound that on big hosts. */
const MAX_THREADS = 8;

async function load(root: string) {
    if (navigator.hardwareConcurrency > MAX_THREADS) {
        Object.defineProperty(navigator, "hardwareConcurrency", { value: MAX_THREADS, configurable: true });
    }
    const moonshine = await import("@moonshine-ai/moonshine-wasm");
    const { ModelArch, TranscribeFlags } = moonshine;
    const module = await moonshine.loadMoonshineModule();
    const manifest = JSON.parse(module.sttDependencies("en", String(ModelArch.SmallStreaming), false)) as Manifest;
    const paths = await ensureModelFiles(manifest, root, (file, pct) => post({ type: "progress", file, pct }));
    const files = new Map([...paths].map(([name, path]) => [name, new Uint8Array(readFileSync(path))]));
    transcriber = await moonshine.Transcriber.load({ files, modelArch: ModelArch.SmallStreaming, module });
    files.clear();
    // The first passes after load run several times slower (JIT warm-up);
    // pay that here, on the same streaming path, instead of on the first utterance.
    let x = 1;
    const noise = new Float32Array(16000 * 2).map(() => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.2);
    for (let round = 0; round < 2; round++) {
        const s = transcriber.createStream();
        s.start();
        for (let i = 0; i < noise.length; i += 4000) {
            s.addAudio(noise.subarray(i, i + 4000), 16000);
            s.transcribe(TranscribeFlags.ForceUpdate);
        }
        s.stop();
        s.close();
    }
}

async function handle(m: HostToWorker) {
    if (m.type === "load") {
        await load(m.root).then(
            () => post({ type: "ready" }),
            (err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }),
        );
        return;
    }
    const { id } = m;
    try {
        if (m.type === "start") {
            if (!transcriber) throw new Error("speech model is not loaded");
            close(id);
            const stream = transcriber.createStream();
            stream.start();
            streams.set(id, { stream, text: "" });
        } else if (m.type === "audio") {
            const s = streams.get(id);
            if (s) {
                s.stream.addAudio(m.pcm, 16000);
                const text = joinLines(s.stream.transcribe());
                if (text !== s.text) {
                    s.text = text;
                    post({ type: "partial", id, text });
                }
            }
            post({ type: "ack", id, samples: m.pcm.length });
        } else if (m.type === "end") {
            const s = streams.get(id);
            if (!s) return;
            s.stream.stop();
            // stop() already ran the final forced pass; this returns its snapshot.
            const text = joinLines(s.stream.transcribe());
            close(id);
            post({ type: "final", id, text });
        } else if (m.type === "batch") {
            if (!transcriber) throw new Error("speech model is not loaded");
            post({ type: "final", id, text: joinLines(transcriber.transcribe(m.pcm, { sampleRate: 16000 })) });
        } else if (m.type === "cancel") {
            close(id);
        }
    } catch (err) {
        close(id);
        post({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
    }
}

// Strictly sequential: a stream opened while the model loads waits for it.
let chain: Promise<void> = Promise.resolve();
process.on("message", (m: HostToWorker) => {
    chain = chain.then(() => handle(m));
});
// Never outlive the runner.
process.on("disconnect", () => process.exit(0));
