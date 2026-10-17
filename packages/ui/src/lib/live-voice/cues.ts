import tomUrl from "./sounds/tom.m4a?url";
import synthUrl from "./sounds/synth.m4a?url";

/** Non-speech audio cues for Live mode. Best effort: a failed cue never breaks the session. */
const cache = new WeakMap<AudioContext, Map<string, Promise<AudioBuffer>>>();

function load(ctx: AudioContext, url: string): Promise<AudioBuffer> {
    let byUrl = cache.get(ctx);
    if (!byUrl) cache.set(ctx, (byUrl = new Map()));
    let buf = byUrl.get(url);
    if (!buf) {
        buf = fetch(url).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b));
        byUrl.set(url, buf);
    }
    return buf;
}

/** Random whole-semitone offset in [-2, +2], as a playback rate. */
export function randomPitchRate(random = Math.random): number {
    return 2 ** ((Math.floor(random() * 5) - 2) / 12);
}

export function playOpenCue(ctx: AudioContext): void {
    void load(ctx, tomUrl).then((buf) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start();
    }).catch(() => {});
}

/** The open tom played backwards. Uses its own context: Live's closes with the overlay. */
export function playCloseCue(): void {
    let ctx: AudioContext;
    try {
        ctx = new AudioContext();
    } catch {
        return;
    }
    void load(ctx, tomUrl).then((buf) => {
        const rev = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
        for (let c = 0; c < buf.numberOfChannels; c++) rev.getChannelData(c).set(buf.getChannelData(c).toReversed());
        const src = ctx.createBufferSource();
        src.buffer = rev;
        src.connect(ctx.destination);
        src.onended = () => void ctx.close().catch(() => {});
        src.start();
    }).catch(() => void ctx.close().catch(() => {}));
}

/** The synth note is mostly decayed by ~2s; overlap the next note onto its tail. */
const NOTE_INTERVAL_S = 2;
/** Below -55dB by 4s; the sample has a stray blip at 7.5s, so never play that far. */
const NOTE_LENGTH_S = 4;

/** Loops the synth (new random pitch each note) until the returned stop() fades it out. */
export function startWaitingCue(ctx: AudioContext): () => void {
    let stopped = false;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    gain.connect(ctx.destination);
    const playing = new Set<AudioBufferSourceNode>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = (buf: AudioBuffer) => {
        if (stopped) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const rate = randomPitchRate();
        src.playbackRate.value = rate;
        src.connect(gain);
        src.onended = () => playing.delete(src);
        src.start(0, 0, NOTE_LENGTH_S); // duration is in buffer time
        playing.add(src);
        timer = setTimeout(() => next(buf), (NOTE_INTERVAL_S / rate) * 1000);
    };
    void load(ctx, synthUrl).then(next).catch(() => {});
    return () => {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + 0.3);
        clearTimeout(timer);
        for (const src of playing) src.stop(t + 0.3);
        setTimeout(() => gain.disconnect(), 400);
    };
}
