/**
 * Local speech engine: Moonshine STT + Kokoro TTS, both ONNX via transformers.js.
 * Models download from Hugging Face on first use into ~/.pizzapi/live/models.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const STT_MODEL = "onnx-community/moonshine-base-ONNX";
export const TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const DEFAULT_VOICE = "af_heart";
export const MODELS_DIR = join(homedir(), ".pizzapi", "live", "models");

/**
 * Whisper labels non-speech instead of inventing words: "(coughing)", "[BLANK_AUDIO]",
 * "*sigh*", "♪". Drop those so a cough is an empty transcript, which Live ignores.
 */
export function stripNonSpeech(text: string): string {
    const t = text.replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*|[♪♫]/g, " ").replace(/\s+/g, " ").trim();
    return /[\p{L}\p{N}]/u.test(t) ? t : "";
}

export type ModelState = "idle" | "loading" | "ready" | "error";

export interface EngineStatus {
    stt: ModelState;
    tts: ModelState;
    /** Download progress 0–100 per file currently loading. */
    progress: Record<string, number>;
    error?: string;
}

type Transcriber = (audio: Float32Array) => Promise<{ text: string } | { text: string }[]>;
type Kokoro = {
    generate(text: string, opts: { voice: string; speed?: number }): Promise<{ toWav(): ArrayBuffer }>;
    list_voices?: () => unknown;
    voices?: Record<string, unknown>;
};

export class SpeechEngine {
    #stt: Promise<Transcriber> | null = null;
    #tts: Promise<Kokoro> | null = null;
    #status: EngineStatus = { stt: "idle", tts: "idle", progress: {} };
    // ponytail: one global queue per model; ONNX sessions run one call at a time anyway.
    #sttQueue: Promise<unknown> = Promise.resolve();
    #ttsQueue: Promise<unknown> = Promise.resolve();

    status(): EngineStatus {
        return { ...this.#status, progress: { ...this.#status.progress } };
    }

    /** Start loading both models without waiting (e.g. when the overlay opens). */
    warm(): void {
        this.#loadStt().catch(() => {});
        this.#loadTts().catch(() => {});
    }

    async transcribe(samples16k: Float32Array): Promise<string> {
        const stt = await this.#loadStt();
        return this.#enqueue("stt", async () => {
            const r = await stt(samples16k);
            return stripNonSpeech(Array.isArray(r) ? r.map((x) => x.text).join(" ") : r.text);
        });
    }

    async synthesize(text: string, voice = DEFAULT_VOICE, speed = 1): Promise<ArrayBuffer> {
        const tts = await this.#loadTts();
        return this.#enqueue("tts", async () => (await tts.generate(text, { voice, speed })).toWav());
    }

    async voices(): Promise<string[]> {
        const tts = await this.#loadTts();
        return Object.keys(tts.voices ?? {});
    }

    #enqueue<T>(which: "stt" | "tts", fn: () => Promise<T>): Promise<T> {
        const prev = which === "stt" ? this.#sttQueue : this.#ttsQueue;
        const next = prev.then(fn, fn);
        const settled = next.catch(() => {});
        if (which === "stt") this.#sttQueue = settled;
        else this.#ttsQueue = settled;
        return next;
    }

    #onProgress = (p: { status?: string; file?: string; progress?: number }) => {
        if (!p.file) return;
        if (p.status === "progress" && typeof p.progress === "number") this.#status.progress[p.file] = Math.round(p.progress);
        if (p.status === "done") delete this.#status.progress[p.file];
    };

    #loadStt(): Promise<Transcriber> {
        if (!this.#stt) {
            this.#status.stt = "loading";
            this.#stt = (async () => {
                const { pipeline, env } = await import("@huggingface/transformers");
                env.cacheDir = MODELS_DIR;
                const p = await pipeline("automatic-speech-recognition", STT_MODEL, {
                    dtype: "q8",
                    progress_callback: this.#onProgress,
                });
                return p as unknown as Transcriber;
            })();
            this.#track(this.#stt, "stt");
        }
        return this.#stt;
    }

    #loadTts(): Promise<Kokoro> {
        if (!this.#tts) {
            this.#status.tts = "loading";
            this.#tts = (async () => {
                const { env } = await import("@huggingface/transformers");
                env.cacheDir = MODELS_DIR;
                const { KokoroTTS } = await import("kokoro-js");
                // fp32 measured fastest on Apple CPUs (~0.4x real time) vs q8 (~0.75x).
                const tts = await KokoroTTS.from_pretrained(TTS_MODEL, {
                    dtype: "fp32",
                    device: "cpu",
                    progress_callback: this.#onProgress,
                });
                return tts as unknown as Kokoro;
            })();
            this.#track(this.#tts, "tts");
        }
        return this.#tts;
    }

    #track(p: Promise<unknown>, which: "stt" | "tts") {
        p.then(
            () => {
                this.#status[which] = "ready";
            },
            (err: unknown) => {
                this.#status[which] = "error";
                this.#status.error = err instanceof Error ? err.message : String(err);
                // Allow a retry on the next request instead of caching the failure forever.
                if (which === "stt") this.#stt = null;
                else this.#tts = null;
            },
        );
    }
}
