/**
 * Browser audio for Live mode: mic capture with a voice-activity detector,
 * WAV encoding for upload, and an ordered playback queue for TTS replies.
 */

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
    onSpeechEnd(wav: ArrayBuffer): void | Promise<void>;
    onDiscard(): void;
    onLevel(level: number): void;
    onError(error: unknown): void;
}

const FRAME = 2048;

/** Request mic access. Call directly from a user gesture on mobile browsers. */
export function requestMicrophone(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error("Microphone capture is unavailable in this browser."));
    return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
}

/** Connect an already-approved mic stream to the audio pipeline. */
export async function startMic(
    ctx: AudioContext,
    h: MicHandlers,
    streamPromise: Promise<MediaStream>,
    signal?: AbortSignal,
): Promise<{ stop(): void; setMuted(m: boolean): void }> {
    const stream = await streamPromise;
    const stopTracks = () => { for (const track of stream.getTracks()) track.stop(); };
    const { createSpeechDetector } = await import("./vad").catch((error: unknown) => {
        stopTracks();
        throw error;
    });
    if (signal?.aborted) {
        stopTracks();
        signal.throwIfAborted();
    }
    let stopped = false;
    let muted = false;
    let transcribing = false;
    let hearing = false;
    let processing: Promise<void> | null = null;
    let generation = 0;
    let processingGeneration = 0;
    const acceptsDetection = () => !stopped && !muted && !transcribing && generation === processingGeneration;
    const detector = await createSpeechDetector(ctx.sampleRate, {
        start: () => {
            if (!acceptsDetection()) return;
            hearing = true;
            h.onSpeechStart();
        },
        discard: () => {
            if (!acceptsDetection()) return;
            hearing = false;
            h.onDiscard();
        },
        end: (samples) => {
            if (!acceptsDetection()) return;
            hearing = false;
            transcribing = true;
            void Promise.resolve().then(() => {
                if (!stopped) return h.onSpeechEnd(encodeWav(samples, 16000));
            }).catch((error: unknown) => { if (!stopped) h.onError(error); }).finally(() => {
                transcribing = false;
                if (!stopped) detector.reset();
            });
        },
    }, signal).catch((error: unknown) => {
        stopTracks();
        throw error;
    });
    if (signal?.aborted) {
        stopTracks();
        await detector.destroy();
        signal.throwIfAborted();
    }
    for (const track of stream.getAudioTracks()) track.enabled = true;
    const nodes: AudioNode[] = [];
    let proc: ScriptProcessorNode;
    try {
        const src = ctx.createMediaStreamSource(stream);
        nodes.push(src);
        // ponytail: reuse the existing browser capture adapter; move to a worklet
        // if ScriptProcessor support is removed. Silero handles speech detection.
        proc = ctx.createScriptProcessor(FRAME, 1, 1);
        nodes.push(proc);
        const sink = ctx.createGain();
        nodes.push(sink);
        sink.gain.value = 0;
        src.connect(proc);
        proc.connect(sink).connect(ctx.destination);
    } catch (error) {
        for (const node of nodes) node.disconnect();
        stopTracks();
        await detector.destroy();
        throw error;
    }
    proc.onaudioprocess = (e) => {
        // Bound inference work: don't build an ever-growing backlog on slow devices.
        if (stopped || muted || transcribing || processing) return;
        const frame = new Float32Array(e.inputBuffer.getChannelData(0));
        h.onLevel(rms(frame));
        processingGeneration = generation;
        processing = detector.process(frame, acceptsDetection)
            .catch((error: unknown) => {
                if (stopped) return;
                stop();
                h.onError(error);
            })
            .finally(() => { processing = null; });
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        signal?.removeEventListener("abort", stop);
        proc.onaudioprocess = null;
        for (const node of nodes) node.disconnect();
        stopTracks();
        // Do not release an ONNX session while its last frame is in flight.
        void Promise.resolve(processing).then(() => detector.destroy()).catch(h.onError);
    };
    signal?.addEventListener("abort", stop, { once: true });
    return {
        stop,
        setMuted(m) {
            if (stopped || muted === m) return;
            generation++;
            muted = m;
            for (const t of stream.getAudioTracks()) t.enabled = !m;
            if (m && hearing) {
                hearing = false;
                h.onDiscard();
            }
            void Promise.resolve(processing).then(() => { if (!stopped) detector.reset(); });
        },
    };
}

/** Kokoro pads each sentence with silence; retain 80 ms to avoid clipping breaths. */
export function playbackBounds(buffer: AudioBuffer): { start: number; end: number } {
    let first = buffer.length;
    let last = -1;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        let start = 0;
        let end = samples.length - 1;
        while (start < samples.length && Math.abs(samples[start]!) < 0.0005) start++;
        while (end >= start && Math.abs(samples[end]!) < 0.0005) end--;
        first = Math.min(first, start);
        last = Math.max(last, end);
    }
    if (last < first) return { start: 0, end: 0 };
    return {
        start: Math.max(0, first / buffer.sampleRate - 0.08),
        end: Math.min(buffer.duration, (last + 1) / buffer.sampleRate + 0.08),
    };
}

/** Plays TTS clips strictly in order; fetching happens as soon as a clip is queued. */
export class PlaybackQueue {
    #queue: { buf: Promise<AudioBuffer | null>; onPlay?: () => void }[] = [];
    #stopCurrent: (() => void) | null = null;
    #paused = false;
    #wake: (() => void) | null = null;
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
        return this.#running && !this.#paused;
    }

    /** Keep the current position and queued audio until speech is confirmed. */
    pause() {
        if (this.#paused) return;
        this.#paused = true;
        this.#stopCurrent?.();
        this.onIdle();
    }

    resume() {
        if (!this.#paused) return;
        this.#paused = false;
        this.#wake?.();
        this.#wake = null;
        if (this.#running) this.onStart();
    }

    /** `onPlay` fires when this clip actually starts (e.g. to sync captions). */
    enqueue(fetchWav: () => Promise<ArrayBuffer>, onPlay?: () => void) {
        const gen = this.#gen;
        const buf = fetchWav()
            .then((wav) => (gen === this.#gen ? this.ctx.decodeAudioData(wav) : null))
            .catch((err) => {
                console.warn("[live-voice] TTS clip failed to fetch/decode; skipping", err);
                return null;
            });
        this.#queue.push({ buf, onPlay });
        if (!this.#running) void this.#drain();
    }

    /** Barge-in: stop now and drop everything queued. */
    clear() {
        this.#gen++;
        this.#queue = [];
        this.#stopCurrent?.();
        this.#paused = false;
        this.#wake?.();
        this.#wake = null;
    }

    async #drain() {
        this.#running = true;
        if (!this.#paused) this.onStart();
        while (this.#queue.length) {
            const gen = this.#gen;
            const item = this.#queue.shift()!;
            const buf = await item.buf;
            if (!buf || gen !== this.#gen) continue;
            const bounds = playbackBounds(buf);
            let offset = bounds.start;
            while (offset < bounds.end && gen === this.#gen) {
                if (this.#paused) await new Promise<void>((resolve) => { this.#wake = resolve; });
                if (gen !== this.#gen) break;
                if (this.#paused) continue;
                item.onPlay?.();
                await new Promise<void>((resolve) => {
                    const node = this.ctx.createBufferSource();
                    node.buffer = buf;
                    node.connect(this.analyser);
                    const startedAt = this.ctx.currentTime;
                    const finish = () => {
                        node.onended = null;
                        node.disconnect();
                        this.#stopCurrent = null;
                        resolve();
                    };
                    node.onended = () => { offset = bounds.end; finish(); };
                    this.#stopCurrent = () => {
                        offset = Math.min(bounds.end, offset + this.ctx.currentTime - startedAt);
                        // Resolve synchronously: resume may arrive before the
                        // browser delivers the stopped source's ended event.
                        node.onended = null;
                        node.stop();
                        finish();
                    };
                    node.start(0, offset, bounds.end - offset);
                });
            }
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
