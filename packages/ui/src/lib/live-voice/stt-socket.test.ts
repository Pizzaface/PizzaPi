import { afterEach, expect, test } from "bun:test";
import { MAX_SOCKET_BUFFER_BYTES, SttSocket, sttSocketUrl } from "./stt-socket";

class FakeWs {
    static all: FakeWs[] = [];
    sent: Array<string | ArrayBuffer> = [];
    readyState = 0;
    bufferedAmount = 0;
    binaryType = "blob";
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    constructor(public url: string) { FakeWs.all.push(this); }
    send(d: string | ArrayBuffer) { this.sent.push(d); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(new Event("open")); }
    drop() { this.onclose?.(new CloseEvent("close")); }
    emit(o: object) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(o) })); }
    json() { return this.sent.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d)); }
}

const sockets: SttSocket[] = [];
afterEach(() => { for (const s of sockets.splice(0)) s.close(); FakeWs.all = []; });
function make(urls = ["ws://a/", "ws://b/"]) {
    const partials: string[] = [];
    const opens: boolean[] = [];
    const failures: string[] = [];
    const s = new SttSocket(urls, { partial: (t) => partials.push(t), openChange: (o) => opens.push(o), failed: (e) => failures.push(e.name) }, (u) => new FakeWs(u) as never);
    sockets.push(s);
    return { s, partials, opens, failures, ws: () => FakeWs.all.at(-1)! };
}

test("socket URL follows the tunnel base scheme", () => {
    expect(sttSocketUrl(new URL("https://abc.t.example/"))).toBe("wss://abc.t.example/api/stt/stream");
    expect(sttSocketUrl(new URL("http://relay/api/tunnel/auth/tok/runner%3Ar/9/"))).toBe("ws://relay/api/tunnel/auth/tok/runner%3Ar/9/api/stt/stream");
});

test("streams audio as PCM16, shows partials, and settles the final exactly once", async () => {
    const { s, partials, ws } = make();
    ws().open();
    expect(s.begin()).toBe(true);
    s.audio(new Float32Array([0.5, -0.5]));
    expect(ws().sent[1]).toBeInstanceOf(ArrayBuffer);
    ws().emit({ type: "partial", id: 1, text: "Run the" });
    const final = s.finish();
    ws().emit({ type: "final", id: 1, text: "Run the tests." });
    ws().emit({ type: "final", id: 1, text: "duplicate" });
    expect(await final).toBe("Run the tests.");
    expect(partials).toEqual(["Run the"]);
    expect(ws().json().map((m) => m.type)).toEqual(["start", "end"]);
});

test("events for a cancelled or superseded utterance are ignored", async () => {
    const { s, partials, ws } = make();
    ws().open();
    s.begin();
    s.cancel();
    s.begin();
    ws().emit({ type: "partial", id: 1, text: "stale" });
    const final = s.finish();
    ws().emit({ type: "final", id: 1, text: "stale final" });
    ws().emit({ type: "final", id: 2, text: "fresh" });
    expect(await final).toBe("fresh");
    expect(partials).toEqual([]);
    expect(ws().json().map((m) => `${m.type}:${m.id}`)).toEqual(["start:1", "cancel:1", "start:2", "end:2"]);
});

test("a drop while awaiting the final rejects once and is never replayed after reconnect", async () => {
    const { s, ws, opens } = make(["ws://a/"]);
    const first = ws();
    first.open();
    s.begin();
    const final = s.finish();
    first.drop();
    const err = await final.catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("SttDisconnected");
    await new Promise((r) => setTimeout(r, 600)); // reconnect backoff
    const second = ws();
    expect(second).not.toBe(first);
    second.open();
    expect(second.sent).toEqual([]); // nothing resent
    second.emit({ type: "final", id: 1, text: "late" }); // and nothing pending to resolve
    first.emit({ type: "final", id: 1, text: "old socket" });
    expect(opens).toEqual([true, false, true]);
    expect(s.open).toBe(true);
});

test("falls back to the signed relay URL when the isolated host never opens", () => {
    const { ws } = make();
    expect(ws().url).toBe("ws://a/");
    ws().drop();
    expect(ws().url).toBe("ws://b/");
});

test("a stalled socket fails the utterance instead of buffering without bound", async () => {
    const { s, ws } = make();
    ws().open();
    s.begin();
    ws().bufferedAmount = MAX_SOCKET_BUFFER_BYTES + 1;
    s.audio(new Float32Array(1600));
    expect(ws().json().map((m) => m.type)).toEqual(["start", "cancel"]);
    expect(ws().sent.some((d) => d instanceof ArrayBuffer)).toBe(false);
    await expect(s.finish()).rejects.toThrow();
});

test("server errors and timeouts reject the pending final", async () => {
    const { s, ws } = make();
    ws().open();
    s.begin();
    const failed = s.finish();
    ws().emit({ type: "error", id: 1, message: "speech model is not ready" });
    await expect(failed).rejects.toThrow("speech model is not ready");
    s.begin();
    await expect(s.finish(5)).rejects.toThrow("timed out");
    expect(ws().json().at(-1)).toEqual({ type: "cancel", id: 2 });
});

test("begin fails cleanly while disconnected", async () => {
    const { s } = make();
    expect(s.begin()).toBe(false);
    await expect(s.finish()).rejects.toThrow("not connected");
});

test("a recognition error during speech is reported by finish(), not mistaken for a disconnect", async () => {
    const { s, ws } = make();
    ws().open();
    s.begin();
    ws().emit({ type: "error", id: 1, message: "speech recognition is falling behind" });
    const err = await s.finish().catch((e: Error) => e);
    expect((err as Error).message).toBe("speech recognition is falling behind");
    expect((err as Error).name).not.toBe("SttDisconnected");
    // The stored failure belongs to that utterance only.
    s.begin();
    const final = s.finish();
    ws().emit({ type: "final", id: 2, text: "ok" });
    expect(await final).toBe("ok");
});

test("failures before finish() are announced immediately; cancels are not", () => {
    const { s, ws, failures } = make(["ws://a/"]);
    ws().open();
    s.begin();
    s.cancel();
    s.begin();
    ws().emit({ type: "error", id: 2, message: "boom" });
    s.begin();
    ws().drop();
    expect(failures).toEqual(["Error", "SttDisconnected"]);
});
