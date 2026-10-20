import { expect, test } from "bun:test";
import { rms, toPcm16 } from "./audio";

test("toPcm16 is little-endian and clamped", () => {
    const pcm = new DataView(toPcm16(new Float32Array([0, 1, -1, 2])));
    expect(pcm.byteLength).toBe(8);
    expect([pcm.getInt16(0, true), pcm.getInt16(2, true), pcm.getInt16(4, true), pcm.getInt16(6, true)]).toEqual([0, 32767, -32768, 32767]);
});

test("rms", () => {
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array([0, 0]))).toBe(0);
});

test("callAudioOutput falls back to direct playback when the loopback never connects", async () => {
    const { callAudioOutput } = await import("./audio");
    const g = globalThis as Record<string, unknown>;
    const saved = { pc: g.RTCPeerConnection, audio: g.Audio };
    let closed = 0;
    g.RTCPeerConnection = class {
        onicecandidate = null; ontrack = null; // ontrack never fires
        addTrack() {} addIceCandidate = async () => {}; close() { closed++; }
        createOffer = async () => ({}); createAnswer = async () => ({});
        setLocalDescription = async () => {}; setRemoteDescription = async () => {};
    };
    g.Audio = class { srcObject = null; pause() {} play = async () => {}; };
    try {
        const ctx = { createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [{}] }, disconnect() {} }) };
        expect(await callAudioOutput(ctx as unknown as AudioContext, 10)).toBeNull();
        expect(closed).toBe(2);
    } finally {
        g.RTCPeerConnection = saved.pc;
        g.Audio = saved.audio;
    }
});
