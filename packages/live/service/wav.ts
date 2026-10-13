/** Minimal PCM WAV helpers. STT models want mono Float32 at 16 kHz. */

export interface DecodedWav {
    sampleRate: number;
    samples: Float32Array; // mono, [-1, 1]
}

/** Decode a PCM16 or Float32 WAV (any channel count; channels are averaged). */
export function decodeWav(buf: Uint8Array): DecodedWav {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
    if (buf.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");

    let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
    let off = 12;
    while (off + 8 <= buf.byteLength) {
        const id = tag(off);
        const size = view.getUint32(off + 4, true);
        const body = off + 8;
        if (id === "fmt ") {
            fmt = {
                format: view.getUint16(body, true),
                channels: view.getUint16(body + 2, true),
                sampleRate: view.getUint32(body + 4, true),
                bits: view.getUint16(body + 14, true),
            };
        } else if (id === "data") {
            if (!fmt) throw new Error("WAV data before fmt chunk");
            const end = Math.min(body + size, buf.byteLength);
            return { sampleRate: fmt.sampleRate, samples: toMono(view, body, end, fmt) };
        }
        off = body + size + (size & 1); // chunks are word-aligned
    }
    throw new Error("WAV has no data chunk");
}

function toMono(
    view: DataView,
    start: number,
    end: number,
    fmt: { format: number; channels: number; bits: number },
): Float32Array {
    const { format, channels, bits } = fmt;
    const isFloat = format === 3 && bits === 32;
    const isPcm16 = format === 1 && bits === 16;
    if (!isFloat && !isPcm16) throw new Error(`unsupported WAV encoding (format ${format}, ${bits}-bit)`);
    const bytes = bits / 8;
    const frames = Math.floor((end - start) / (bytes * channels));
    const out = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
            const p = start + (i * channels + c) * bytes;
            sum += isFloat ? view.getFloat32(p, true) : view.getInt16(p, true) / 32768;
        }
        out[i] = sum / channels;
    }
    return out;
}

/** Linear resample — fine for speech going into an STT model. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
    if (from === to) return samples;
    const ratio = from / to;
    const out = new Float32Array(Math.floor(samples.length / ratio));
    for (let i = 0; i < out.length; i++) {
        const x = i * ratio;
        const i0 = Math.floor(x);
        const i1 = Math.min(i0 + 1, samples.length - 1);
        out[i] = samples[i0]! + (samples[i1]! - samples[i0]!) * (x - i0);
    }
    return out;
}
