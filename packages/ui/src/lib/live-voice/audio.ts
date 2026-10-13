/**
 * Browser audio for Live mode: mic capture with a voice-activity detector,
 * WAV encoding for upload, and an ordered playback queue for TTS replies.
 */

export interface VadEvent {
    type: "start" | "end" | "discard";
}

/**
 * Adaptive energy VAD over fixed-size frames.
 * ponytail: RMS + noise floor, not a neural VAD. Fine with echo cancellation in
 * a normal room; swap for Silero (onnxruntime-web, ~10 MB wasm) if noisy
 * environments or TTS self-triggering become a problem.
 */
export class EnergyVad {
    floor = 0.004;
    #speaking = false;
    #voiced = 0;
    #silent = 0;
    #frames = 0;

    constructor(
        private frameMs: number,
        private opts = { startMs: 90, endSilenceMs: 800, minSpeechMs: 300, maxSpeechMs: 30_000 },
    ) {}

    get speaking() {
        return this.#speaking;
    }

    /** `strict` raises the bar while our own TTS is playing (barge-in must be deliberate). */
    feed(rms: number, strict = false): VadEvent | null {
        const threshold = Math.max(this.floor * (strict ? 6 : 3), strict ? 0.04 : 0.012);
        const voiced = rms > threshold;
        if (!this.#speaking) {
            // Track the room's noise floor only while nobody (us included) is talking.
            if (!voiced && !strict) this.floor = Math.min(Math.max(this.floor * 0.95 + rms * 0.05, 0.002), 0.05);
            this.#voiced = voiced ? this.#voiced + 1 : 0;
            if (this.#voiced * this.frameMs >= this.opts.startMs) {
                this.#speaking = true;
                this.#silent = 0;
                this.#frames = this.#voiced;
                return { type: "start" };
            }
            return null;
        }
        this.#frames++;
        this.#silent = voiced ? 0 : this.#silent + 1;
        const done = this.#silent * this.frameMs >= this.opts.endSilenceMs || this.#frames * this.frameMs >= this.opts.maxSpeechMs;
        if (!done) return null;
        this.#speaking = false;
        this.#voiced = 0;
        const speechMs = (this.#frames - this.#silent) * this.frameMs;
        return { type: speechMs >= this.opts.minSpeechMs ? "end" : "discard" };
    }
}

export function rms(frame: Float32Array): number {
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += frame[i]! * frame[i]!;
    return Math.sqrt(s / frame.length);
}

/** Mono PCM16 WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF");
    v.setUint32(4, 36 + samples.length * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]!));
        v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
}

export interface MicHandlers {
    onSpeechStart(): void;
    onSpeechEnd(wav: ArrayBuffer): void;
    onDiscard(): void;
    onLevel(level: number): void;
    /** True while TTS is playing, so the VAD demands a louder, deliberate barge-in. */
    isPlaying(): boolean;
}

const FRAME = 2048;
const PREROLL_FRAMES = 6;

/** Open the mic. Must be called from a user gesture on iOS (shares `ctx`). */
export async function startMic(ctx: AudioContext, h: MicHandlers): Promise<{ stop(): void; setMuted(m: boolean): void }> {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const src = ctx.createMediaStreamSource(stream);
    // ponytail: ScriptProcessorNode is deprecated but works everywhere (incl. iOS
    // Safari) with no worklet module to serve; move to AudioWorklet if it's removed.
    const proc = ctx.createScriptProcessor(FRAME, 1, 1);
    const vad = new EnergyVad((FRAME / ctx.sampleRate) * 1000);
    const preroll: Float32Array[] = [];
    let utterance: Float32Array[] = [];
    let muted = false;

    proc.onaudioprocess = (e) => {
        const frame = new Float32Array(e.inputBuffer.getChannelData(0));
        if (muted) return;
        const level = rms(frame);
        h.onLevel(level);
        const wasSpeaking = vad.speaking;
        const ev = vad.feed(level, h.isPlaying());
        if (wasSpeaking || ev?.type === "start") utterance.push(frame);
        else {
            preroll.push(frame);
            if (preroll.length > PREROLL_FRAMES) preroll.shift();
        }
        if (ev?.type === "start") {
            utterance = [...preroll, ...utterance];
            preroll.length = 0;
            h.onSpeechStart();
        } else if (ev) {
            const all = utterance;
            utterance = [];
            if (ev.type === "discard") return h.onDiscard();
            const merged = new Float32Array(all.reduce((n, f) => n + f.length, 0));
            let o = 0;
            for (const f of all) {
                merged.set(f, o);
                o += f.length;
            }
            h.onSpeechEnd(encodeWav(merged, ctx.sampleRate));
        }
    };
    src.connect(proc);
    // Some browsers only pull audio through a processor that reaches the destination.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    proc.connect(sink).connect(ctx.destination);

    return {
        stop() {
            proc.onaudioprocess = null;
            proc.disconnect();
            src.disconnect();
            sink.disconnect();
            for (const t of stream.getTracks()) t.stop();
        },
        setMuted(m) {
            muted = m;
            for (const t of stream.getAudioTracks()) t.enabled = !m;
        },
    };
}

/** Plays TTS clips strictly in order; fetching happens as soon as a clip is queued. */
export class PlaybackQueue {
    #queue: { buf: Promise<AudioBuffer | null>; onPlay?: () => void }[] = [];
    #current: AudioBufferSourceNode | null = null;
    #gen = 0;
    #running = false;
    readonly analyser: AnalyserNode;

    constructor(
        private ctx: AudioContext,
        private onIdle: () => void,
        private onStart: () => void,
    ) {
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.connect(ctx.destination);
    }

    get playing() {
        return this.#running;
    }

    /** `onPlay` fires when this clip actually starts (e.g. to sync captions). */
    enqueue(fetchWav: () => Promise<ArrayBuffer>, onPlay?: () => void) {
        const gen = this.#gen;
        const buf = fetchWav()
            .then((wav) => (gen === this.#gen ? this.ctx.decodeAudioData(wav) : null))
            .catch(() => null);
        this.#queue.push({ buf, onPlay });
        if (!this.#running) void this.#drain();
    }

    /** Barge-in: stop now and drop everything queued. */
    clear() {
        this.#gen++;
        this.#queue = [];
        try {
            this.#current?.stop();
        } catch {
            /* already stopped */
        }
    }

    async #drain() {
        this.#running = true;
        this.onStart();
        while (this.#queue.length) {
            const gen = this.#gen;
            const item = this.#queue.shift()!;
            const buf = await item.buf;
            if (!buf || gen !== this.#gen) continue;
            item.onPlay?.();
            await new Promise<void>((resolve) => {
                const node = this.ctx.createBufferSource();
                node.buffer = buf;
                node.connect(this.analyser);
                node.onended = () => resolve();
                this.#current = node;
                node.start();
            });
            this.#current = null;
        }
        this.#running = false;
        this.onIdle();
    }

    /** 0–1 output loudness for the orb. */
    level(): number {
        const data = new Uint8Array(this.analyser.fftSize);
        this.analyser.getByteTimeDomainData(data);
        let s = 0;
        for (const d of data) s += ((d - 128) / 128) ** 2;
        return Math.sqrt(s / data.length);
    }
}
