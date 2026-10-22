/**
 * Browser audio for Live mode: mic capture with a voice-activity detector that
 * streams utterance audio as it is spoken, and an ordered playback queue for TTS replies.
 */

export function rms(frame: Float32Array): number {
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += frame[i]! * frame[i]!;
    return Math.sqrt(s / frame.length);
}

/** Little-endian PCM16, clamped: the wire format for streamed speech. */
export function toPcm16(samples: Float32Array): ArrayBuffer {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]!));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
}

export interface MicHandlers {
    onSpeechStart(): void;
    /** Utterance audio (16 kHz mono), streamed between onSpeechStart and onSpeechEnd. */
    onAudio(samples16k: Float32Array): void;
    /** Detection pauses until the returned promise settles (awaiting the final transcript). */
    onSpeechEnd(): void | Promise<void>;
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
    // Frames that arrived while the detector was busy. They are the utterance
    // audio as well as VAD input, so they queue instead of being dropped.
    // ponytail: ~1 s cap, oldest dropped beyond it; a device that slow is losing speech anyway.
    const pending: Float32Array[] = [];
    const MAX_PENDING = Math.ceil(ctx.sampleRate / FRAME);
    const detector = await createSpeechDetector(ctx.sampleRate, {
        start: () => {
            if (!acceptsDetection()) return;
            hearing = true;
            h.onSpeechStart();
        },
        audio: (samples) => {
            if (!acceptsDetection() || !hearing) return;
            h.onAudio(samples);
        },
        discard: () => {
            if (!acceptsDetection()) return;
            hearing = false;
            h.onDiscard();
        },
        end: () => {
            if (!acceptsDetection() || !hearing) return;
            hearing = false;
            transcribing = true;
            pending.length = 0;
            void Promise.resolve().then(() => {
                if (!stopped) return h.onSpeechEnd();
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
    const run = (frame: Float32Array) => {
        processingGeneration = generation;
        processing = detector.process(frame, acceptsDetection)
            .catch((error: unknown) => {
                if (stopped) return;
                stop();
                h.onError(error);
            })
            .finally(() => {
                processing = null;
                const next = pending.shift();
                if (next && !stopped && !muted && !transcribing) run(next);
            });
    };
    proc.onaudioprocess = (e) => {
        if (stopped || muted || transcribing) return;
        const frame = new Float32Array(e.inputBuffer.getChannelData(0));
        h.onLevel(rms(frame));
        if (!processing) return run(frame);
        if (pending.length >= MAX_PENDING) pending.shift();
        pending.push(frame);
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        pending.length = 0;
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
            pending.length = 0;
            for (const t of stream.getAudioTracks()) t.enabled = !m;
            if (m && hearing) {
                hearing = false;
                h.onDiscard();
            }
            void Promise.resolve(processing).then(() => { if (!stopped) detector.reset(); });
        },
    };
}

/**
 * Play Live's voice through a local WebRTC call instead of straight to the
 * speakers. On Android, Chromium's echo canceller only references call audio,
 * so Web Audio media playback leaks back into the mic. Returns the node to
 * play into, or null (keep ctx.destination) if the loopback can't start.
 * Setup takes ~1.5–3.5 s in desktop Chromium; playback stays direct until then.
 */
export async function callAudioOutput(ctx: AudioContext, timeoutMs = 10_000): Promise<{ node: AudioNode; close(): void } | null> {
    if (typeof RTCPeerConnection === "undefined" || !ctx.createMediaStreamDestination) return null;
    const dest = ctx.createMediaStreamDestination();
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    const el = new Audio();
    const close = () => {
        el.pause();
        el.srcObject = null;
        a.close();
        b.close();
        dest.disconnect();
    };
    try {
        a.onicecandidate = (e) => { if (e.candidate) void b.addIceCandidate(e.candidate).catch(() => {}); };
        b.onicecandidate = (e) => { if (e.candidate) void a.addIceCandidate(e.candidate).catch(() => {}); };
        const remote = new Promise<MediaStream>((resolve) => {
            b.ontrack = (e) => resolve(e.streams[0] ?? new MediaStream([e.track]));
        });
        for (const track of dest.stream.getAudioTracks()) a.addTrack(track, dest.stream);
        const offer = await a.createOffer();
        await a.setLocalDescription(offer);
        await b.setRemoteDescription(offer);
        const answer = await b.createAnswer();
        await b.setLocalDescription(answer);
        await a.setRemoteDescription(answer);
        const connected = (async () => {
            el.srcObject = await remote;
            await el.play();
        })();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            connected,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("loopback timeout")), timeoutMs); }),
        ]).finally(() => clearTimeout(timer));
        return { node: dest, close };
    } catch (error) {
        console.warn("[live-voice] call-audio loopback unavailable; playing directly", error);
        close();
        return null;
    }
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
    #volume: GainNode;

    constructor(
        private ctx: AudioContext,
        private onIdle: () => void,
        private onStart: () => void,
    ) {
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.connect(ctx.destination);
        this.#volume = ctx.createGain();
        this.#volume.connect(this.analyser);
    }

    /** Quieter while a possible interruption is checked; also feeds the mic less echo. resume() restores. */
    duck(on: boolean) {
        this.#volume.gain.value = on ? 0.2 : 1;
    }

    /** Send playback (not just cues) to another output, e.g. callAudioOutput(). */
    routeTo(node: AudioNode) {
        this.analyser.disconnect();
        this.analyser.connect(node);
    }

    /** Clips are playing, paused or still queued. */
    get busy() {
        return this.#running;
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

    /** Undo pause() and/or duck(): the candidate interruption was noise. */
    resume() {
        this.duck(false);
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
        this.duck(false);
        this.#gen++;
        this.#queue = [];
        this.#stopCurrent?.();
        this.#paused = false;
        this.#wake?.();
        this.#wake = null;
    }

    async #drain() {
        this.#running = true;
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
                // "Speaking" starts with audible audio, not when the TTS fetch is queued.
                this.onStart();
                item.onPlay?.();
                await new Promise<void>((resolve) => {
                    const node = this.ctx.createBufferSource();
                    node.buffer = buf;
                    node.connect(this.#volume);
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
