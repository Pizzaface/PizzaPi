/**
 * Streaming speech-to-text over the Live service's tunnel WebSocket.
 *
 * One utterance at a time. Each gets a fresh id; partial/final/error events for
 * any other id (or from a previous socket) are ignored. finish() settles once:
 * with the final text, or with an error if the socket drops first. A dropped
 * utterance is never replayed on the reconnected socket, so a finalized
 * utterance can't be dispatched twice.
 */
import { toPcm16 } from "./audio";

/** Give up on an utterance rather than queue unbounded audio on a stalled socket. */
export const MAX_SOCKET_BUFFER_BYTES = 512 * 1024;
const PING_MS = 25_000;

type Ws = Pick<WebSocket, "send" | "close" | "readyState" | "bufferedAmount" | "binaryType"> & {
    onopen: ((e: Event) => void) | null;
    onmessage: ((e: MessageEvent) => void) | null;
    onclose: ((e: CloseEvent) => void) | null;
    onerror: ((e: Event) => void) | null;
};

export interface SttSocketEvents {
    partial(text: string): void;
    openChange(open: boolean): void;
    /** The current utterance failed before finish() (error or dropped socket). finish() still reports it. */
    failed?(err: Error): void;
}

interface Utterance {
    id: number;
    ended: boolean;
    settle?: { resolve(text: string): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };
}

/** The socket dropped or isn't connected; it reconnects on its own, so this isn't fatal. */
export const disconnected = (message: string) => Object.assign(new Error(message), { name: "SttDisconnected" });

/** ws(s):// URL for the service's streaming endpoint under a tunnel base URL. */
export function sttSocketUrl(base: URL): string {
    const u = new URL("api/stt/stream", base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.href;
}

export class SttSocket {
    #ws: Ws | null = null;
    #open = false;
    #closed = false;
    #attempt = 0;
    #retry: ReturnType<typeof setTimeout> | undefined;
    #ping: ReturnType<typeof setInterval> | undefined;
    #nextId = 1;
    #cur: Utterance | null = null;
    /** Why the current utterance failed before finish() was called, so finish() can report it. */
    #failed: Error | null = null;

    constructor(
        private urls: string[],
        private ev: SttSocketEvents,
        private create: (url: string) => Ws = (url) => new WebSocket(url),
    ) {
        this.#connect(0);
    }

    get open() {
        return this.#open;
    }

    /** Start an utterance. False when the socket isn't connected. */
    begin(): boolean {
        this.cancel();
        this.#failed = null;
        if (!this.#open || !this.#ws) return false;
        const id = this.#nextId++;
        this.#cur = { id, ended: false };
        this.#ws.send(JSON.stringify({ type: "start", id }));
        return true;
    }

    audio(samples16k: Float32Array) {
        const cur = this.#cur;
        if (!cur || cur.ended || !this.#ws) return;
        if (this.#ws.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
            this.#fail(new Error("Network too slow for live transcription."), true);
            return;
        }
        this.#ws.send(toPcm16(samples16k));
    }

    /** Ask for the final transcript of the current utterance. */
    finish(timeoutMs = 10_000): Promise<string> {
        const cur = this.#cur;
        const failed = this.#failed;
        this.#failed = null;
        if (!cur && failed) return Promise.reject(failed);
        if (!cur || cur.ended || !this.#ws) return Promise.reject(disconnected("Speech service is not connected."));
        cur.ended = true;
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => this.#fail(new Error("Transcription timed out."), true), timeoutMs);
            cur.settle = { resolve, reject, timer };
            this.#ws!.send(JSON.stringify({ type: "end", id: cur.id }));
        });
    }

    /** Drop the current utterance (discarded speech, mute, close). */
    cancel() {
        const cur = this.#cur;
        if (!cur) return;
        this.#fail(Object.assign(new Error("cancelled"), { name: "AbortError" }), true);
    }

    close() {
        this.#closed = true;
        this.cancel();
        clearTimeout(this.#retry);
        this.#teardown();
    }

    #fail(err: Error, notifyServer: boolean) {
        const cur = this.#cur;
        if (!cur) return;
        this.#cur = null;
        if (notifyServer && this.#open) this.#ws?.send(JSON.stringify({ type: "cancel", id: cur.id }));
        if (cur.settle) {
            clearTimeout(cur.settle.timer);
            cur.settle.reject(err);
        } else if (err.name !== "AbortError") {
            this.#failed = err;
            this.ev.failed?.(err);
        }
    }

    #teardown() {
        clearInterval(this.#ping);
        const ws = this.#ws;
        this.#ws = null;
        if (ws) {
            ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
            try {
                ws.close();
            } catch {
                /* already closed */
            }
        }
        if (this.#open) {
            this.#open = false;
            this.ev.openChange(false);
        }
    }

    #connect(urlIndex: number) {
        if (this.#closed) return;
        let opened = false;
        let ws: Ws;
        try {
            ws = this.create(this.urls[urlIndex]!);
        } catch {
            this.#scheduleRetry(urlIndex, false);
            return;
        }
        ws.binaryType = "arraybuffer";
        this.#ws = ws;
        ws.onopen = () => {
            opened = true;
            this.#attempt = 0;
            this.#open = true;
            this.#ping = setInterval(() => ws.send(JSON.stringify({ type: "ping" })), PING_MS);
            this.ev.openChange(true);
        };
        ws.onmessage = (e) => {
            if (typeof e.data !== "string") return;
            let m: { type?: string; id?: number; text?: string; message?: string };
            try {
                m = JSON.parse(e.data);
            } catch {
                return;
            }
            const cur = this.#cur;
            if (!cur || m.id !== cur.id) return;
            if (m.type === "partial" && !cur.settle) this.ev.partial(m.text ?? "");
            else if (m.type === "final") {
                if (!cur.settle) return; // final without finish(): server-side end we didn't ask for
                this.#cur = null;
                clearTimeout(cur.settle.timer);
                cur.settle.resolve(m.text ?? "");
            } else if (m.type === "error") this.#fail(new Error(m.message ?? "transcription failed"), false);
        };
        ws.onclose = ws.onerror = () => {
            if (this.#ws !== ws) return;
            this.#fail(disconnected("Lost connection to the speech service."), false);
            this.#teardown();
            this.#scheduleRetry(urlIndex, opened);
        };
    }

    #scheduleRetry(urlIndex: number, wasOpen: boolean) {
        if (this.#closed) return;
        // Never opened: try the next URL (signed relay path) right away.
        if (!wasOpen && urlIndex + 1 < this.urls.length) return this.#connect(urlIndex + 1);
        const delay = Math.min(10_000, 500 * 2 ** this.#attempt++);
        this.#retry = setTimeout(() => this.#connect(0), delay);
    }
}
