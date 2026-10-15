import { FrameProcessor } from "@ricky0123/vad-web/dist/frame-processor";
import { Message } from "@ricky0123/vad-web/dist/messages";
import { Resampler } from "@ricky0123/vad-web/dist/resampler";
import type { SpeechProbabilities } from "@ricky0123/vad-web/dist/models";

export const SPEECH_OPTIONS = {
    positiveSpeechThreshold: 0.8,
    negativeSpeechThreshold: 0.35,
    minSpeechMs: 160,
    preSpeechPadMs: 300,
    redemptionMs: 500,
    submitUserSpeechOnPause: false,
};

export interface SpeechModel {
    process(frame: Float32Array): Promise<SpeechProbabilities>;
    reset_state(): void;
    release(): Promise<void>;
}

export interface SpeechEvents {
    start(): void;
    end(samples16k: Float32Array): void;
    discard(): void;
}

/** Separated from WASM loading so lifecycle tests can drive real segmentation. */
export function speechDetector(model: SpeechModel, sampleRate: number, events: SpeechEvents) {
    const processor = new FrameProcessor(model.process, model.reset_state, SPEECH_OPTIONS, 32);
    let resampler = new Resampler({ nativeSampleRate: sampleRate, targetSampleRate: 16000, targetFrameSize: 512 });
    let utteranceMs = 0;
    let stopped = false;
    processor.resume();
    const handleEvent: Parameters<FrameProcessor["process"]>[1] = (event) => {
        if (stopped) return;
        if (event.msg === Message.SpeechRealStart) events.start();
        if (event.msg === Message.VADMisfire) events.discard();
        if (event.msg === Message.SpeechEnd) events.end(event.audio);
    };
    return {
        async process(frame: Float32Array, enabled: () => boolean) {
            for (const samples of resampler.process(frame)) {
                if (stopped || !enabled()) break;
                await processor.process(samples, handleEvent);
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
