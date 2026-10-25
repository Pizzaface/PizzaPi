import { FrameProcessor } from "@ricky0123/vad-web/dist/frame-processor";
import { Message } from "@ricky0123/vad-web/dist/messages";
import { Resampler } from "@ricky0123/vad-web/dist/resampler";
import type { SpeechProbabilities } from "@ricky0123/vad-web/dist/models";

export const SPEECH_OPTIONS = {
    positiveSpeechThreshold: 0.8,
    negativeSpeechThreshold: 0.35,
    minSpeechMs: 160,
    preSpeechPadMs: 300,
    // A thinking pause shouldn't end (and send) the user's turn.
    redemptionMs: 1000,
    submitUserSpeechOnPause: false,
};

export interface SpeechModel {
    process(frame: Float32Array): Promise<SpeechProbabilities>;
    reset_state(): void;
    release(): Promise<void>;
}

export interface SpeechEvents {
    /** Speech confirmed (minSpeechMs of voiced frames). */
    start(): void;
    /** 16 kHz audio of the confirmed utterance, in order: pre-roll first, then each frame as it arrives. */
    audio(samples16k: Float32Array): void;
    /** End of the utterance; every audio() for it has already been delivered. */
    end(): void;
    discard(): void;
}

const PRE_ROLL_FRAMES = Math.floor(SPEECH_OPTIONS.preSpeechPadMs / 32);

function concat(frames: Float32Array[]): Float32Array {
    const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
    let o = 0;
    for (const f of frames) {
        out.set(f, o);
        o += f.length;
    }
    return out;
}

/**
 * Separated from WASM loading so lifecycle tests can drive real segmentation.
 * Audio streams out while the user talks, so recognition can run alongside
 * speech instead of after it. Until speech is confirmed, frames are only held
 * (pre-roll + candidate), never sent.
 */
export function speechDetector(model: SpeechModel, sampleRate: number, events: SpeechEvents) {
    const processor = new FrameProcessor(model.process, model.reset_state, SPEECH_OPTIONS, 32);
    let resampler = new Resampler({ nativeSampleRate: sampleRate, targetSampleRate: 16000, targetFrameSize: 512 });
    let utteranceMs = 0;
    let stopped = false;
    // Frames not yet streamed: the pre-roll window, or a candidate that isn't confirmed yet.
    let held: Float32Array[] = [];
    let streaming = false;
    const flush = () => {
        if (held.length) events.audio(concat(held));
        held = [];
    };
    processor.resume();
    const handleEvent: Parameters<FrameProcessor["process"]>[1] = (event) => {
        if (stopped) return;
        if (event.msg === Message.FrameProcessed) held.push(event.frame);
        if (event.msg === Message.SpeechRealStart) {
            streaming = true;
            events.start();
            flush();
        }
        if (event.msg === Message.VADMisfire) {
            held = held.slice(-PRE_ROLL_FRAMES);
            streaming = false;
            events.discard();
        }
        if (event.msg === Message.SpeechEnd) {
            if (streaming) {
                flush();
                events.end();
            }
            streaming = false;
            held = [];
        }
    };
    return {
        async process(frame: Float32Array, enabled: () => boolean) {
            for (const samples of resampler.process(frame)) {
                if (stopped || !enabled()) break;
                await processor.process(samples, handleEvent);
                if (streaming) flush();
                else if (!processor.speaking && held.length > PRE_ROLL_FRAMES) held = held.slice(-PRE_ROLL_FRAMES);
                utteranceMs = processor.speaking ? utteranceMs + 32 : 0;
                // Bound continuous speech/noise; never accumulate an unbounded clip.
                if (utteranceMs >= 30_000) {
                    processor.endSegment(handleEvent);
                    utteranceMs = 0;
                }
            }
        },
        reset() {
            processor.reset();
            held = [];
            streaming = false;
            resampler = new Resampler({ nativeSampleRate: sampleRate, targetSampleRate: 16000, targetFrameSize: 512 });
            utteranceMs = 0;
        },
        async destroy() {
            stopped = true;
            processor.pause(handleEvent);
            await model.release();
        },
    };
}

export async function createSpeechDetector(sampleRate: number, events: SpeechEvents, signal?: AbortSignal) {
    const { loadSpeechModel } = await import("./vad-runtime");
    const model = await loadSpeechModel(signal);
    if (signal?.aborted) {
        await model.release();
        signal.throwIfAborted();
    }
    return speechDetector(model, sampleRate, events);
}
