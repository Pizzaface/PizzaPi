/**
 * Local speech engine: streaming Moonshine STT (official WASM, in a worker; see
 * stt.ts) + Kokoro TTS (ONNX via transformers.js). Models download on first use
 * into ~/.pizzapi/live/models.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { IDLE_UNLOAD_MS, LOAD_STALL_MS, StreamingStt } from "./stt.ts";

export const TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const DEFAULT_VOICE = "af_heart";
export const MODELS_DIR = join(homedir(), ".pizzapi", "live", "models");

const NON_SPEECH =
    /^(?:blank[ _]audio|silence|inaudible|music|noise|background noise|applause|laugh(?:s|ing|ter)?|cough(?:s|ing)?|sigh(?:s|ing)?|sneez(?:e|es|ing)|breath(?:es|ing)?|clears? throat|throat clearing|sniff(?:s|ing)?)$/i;

/**
 * ASR models sometimes label non-speech instead of inventing words: "(coughing)",
 * "[BLANK_AUDIO]", "*sigh*", "♪". Drop only those labels, so a cough is an empty
 * transcript, while ordinary parenthetical speech ("run it (with tests)") stays.
 */
export function stripNonSpeech(text: string): string {
    const t = text
        .replace(/\(([^)]*)\)|\[([^\]]*)\]|\*([^*]*)\*/g, (m, a, b, c) => (NON_SPEECH.test(String(a ?? b ?? c).trim()) ? " " : m))
        .replace(/[♪♫]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return /[\p{L}\p{N}]/u.test(t) ? t.replace(/^[\s.,;:!?-]+/, "") : "";
}

export type ModelState = "idle" | "loading" | "ready" | "error";

export interface EngineStatus {
    stt: ModelState;
    tts: ModelState;
    /** Download progress 0–100 per file currently loading. */
    progress: Record<string, number>;
    error?: string;
}

type Kokoro = {
    generate(text: string, opts: { voice: string; speed?: number }): Promise<{ toWav(): ArrayBuffer }>;
    list_voices?: () => unknown;
    voices?: Record<string, unknown>;
    /** transformers.js PreTrainedModel; dispose() releases its ONNX sessions. */
    model?: { dispose?(): Promise<unknown> };
};

/** Kokoro via transformers.js (ONNX, native runtime in Bun). Models cache under MODELS_DIR. */
export async function loadKokoro(onProgress: (p: { status?: string; file?: string; progress?: number }) => void): Promise<Kokoro> {
    const { env } = await import("@huggingface/transformers");
    env.cacheDir = MODELS_DIR;
    const { KokoroTTS } = await import("kokoro-js");
    // fp32 measured fastest on Apple CPUs (~0.4x real time) vs q8 (~0.75x).
    const tts = await KokoroTTS.from_pretrained(TTS_MODEL, { dtype: "fp32", device: "cpu", progress_callback: onProgress });
    return tts as unknown as Kokoro;
}

export class SpeechEngine {
    #tts: Promise<Kokoro> | null = null;
    #ttsState: ModelState = "idle";
    #ttsError: string | undefined;
    #progress: Record<string, number> = {};
    // ponytail: one global queue; the ONNX session runs one call at a time anyway.
    #ttsQueue: Promise<unknown> = Promise.resolve();
    #refs = 0;
    #ttsIdle: ReturnType<typeof setTimeout> | undefined;

    constructor(
        readonly stt = new StreamingStt(),
        private idleMs = IDLE_UNLOAD_MS,
        private load: typeof loadKokoro = loadKokoro,
        private stallMs = LOAD_STALL_MS,
    ) {}

    /** Keep both models loaded while a client is connected; unload them after idling. */
    retain(): () => void {
        this.#refs++;
        clearTimeout(this.#ttsIdle);
        const releaseStt = this.stt.retain();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.#refs--;
            releaseStt();
            this.#scheduleTtsIdle();
        };
    }

    status(): EngineStatus {
        const stt = this.stt.status();
        const error = stt.error ?? this.#ttsError;
        return { stt: stt.state, tts: this.#ttsState, progress: { ...this.#progress, ...stt.progress }, ...(error ? { error } : {}) };
    }

    /** Start loading both models without waiting (e.g. when the overlay opens). */
    warm(): void {
        this.stt.warm().catch(() => {});
        this.#loadTts().catch(() => {});
    }

    /** Whole-clip transcription; live captions use the streaming WebSocket instead. */
    async transcribe(samples16k: Float32Array): Promise<string> {
        await this.stt.warm();
        return stripNonSpeech(await this.stt.transcribe(samples16k));
    }

    async synthesize(text: string, voice = DEFAULT_VOICE, speed = 1): Promise<ArrayBuffer> {
        clearTimeout(this.#ttsIdle);
        const tts = await this.#loadTts();
        const next = this.#ttsQueue.then(async () => (await tts.generate(text, { voice, speed })).toWav());
        this.#ttsQueue = next.catch(() => {}).finally(() => this.#scheduleTtsIdle());
        return next;
    }

    async voices(): Promise<string[]> {
        const tts = await this.#loadTts();
        return Object.keys(tts.voices ?? {});
    }

    dispose(): void {
        clearTimeout(this.#ttsIdle);
        this.#unloadTts();
        this.stt.dispose();
    }

    #scheduleTtsIdle() {
        clearTimeout(this.#ttsIdle);
        if (this.#refs > 0 || !this.#tts || this.#ttsState !== "ready") return;
        // ponytail: Kokoro (native ORT, fp32) stays resident in the daemon otherwise; reload costs a few seconds.
        this.#ttsIdle = setTimeout(() => this.#unloadTts(), this.idleMs);
        (this.#ttsIdle as { unref?: () => void }).unref?.();
    }

    /** Release the ONNX sessions once in-flight synthesis has drained. The next request reloads. */
    #unloadTts() {
        const p = this.#tts;
        if (!p) return;
        this.#tts = null;
        this.#ttsState = "idle";
        this.#ttsQueue = this.#ttsQueue.then(async () => {
            const tts = await p.catch(() => null);
            await tts?.model?.dispose?.().catch(() => {});
        });
    }

    #onProgress = (p: { status?: string; file?: string; progress?: number }) => {
        if (!p.file) return;
        if (p.status === "progress" && typeof p.progress === "number") this.#progress[p.file] = Math.round(p.progress);
        if (p.status === "done") delete this.#progress[p.file];
    };

    #loadTts(): Promise<Kokoro> {
        if (!this.#tts) {
            this.#ttsState = "loading";
            this.#ttsError = undefined;
            // A download with no progress for stallMs fails the load (retryable) instead of pinning "loading".
            let stall: ReturnType<typeof setTimeout> | undefined;
            const touch = () => {
                clearTimeout(stall);
                stall = setTimeout(() => {
                    if (this.#tts !== p) return;
                    this.#tts = null;
                    this.#ttsState = "error";
                    this.#ttsError = "voice model load stalled";
                }, this.stallMs);
                (stall as { unref?: () => void }).unref?.();
            };
            touch();
            const p: Promise<Kokoro> = this.load((e) => {
                touch();
                this.#onProgress(e);
            });
            this.#tts = p;
            p.then(
                (tts) => {
                    clearTimeout(stall);
                    // Unloaded or timed out while loading: don't keep a model nobody tracks.
                    if (this.#tts !== p) return void tts.model?.dispose?.().catch(() => {});
                    this.#ttsState = "ready";
                    this.#scheduleTtsIdle();
                },
                (err: unknown) => {
                    clearTimeout(stall);
                    if (this.#tts !== p) return;
                    this.#ttsState = "error";
                    this.#ttsError = err instanceof Error ? err.message : String(err);
                    // Allow a retry on the next request instead of caching the failure forever.
                    this.#tts = null;
                },
            );
        }
        return this.#tts;
    }
}
