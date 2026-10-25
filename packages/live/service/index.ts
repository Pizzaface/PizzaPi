/**
 * Live voice runner service. The web UI's Live overlay talks to this over the
 * tunnel: streaming speech in (WebSocket /api/stt/stream), speech out
 * (/api/tts), and the per-session "live" flag the session extension reads.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server, ServerWebSocket } from "bun";
import { setLive } from "../flags.ts";
import { DEFAULT_VOICE, SpeechEngine, stripNonSpeech } from "./engine.ts";
import type { SttStream } from "./stt.ts";
import { decodeWav, resample } from "./wav.ts";

const MAX_TTS_CHARS = 1000;
const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: CORS });

export async function handleRequest(req: Request, engine: SpeechEngine, indexHtml: string): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const path = new URL(req.url).pathname;
    // Match our routes by suffix in case a tunnel prefix (itself under /api/) survives.
    const route = path.match(/\/api\/(?:stt|tts|status|warm|voices|session\/[^/]+\/live)$/)?.[0] ?? path;

    try {
        if (route === "/api/status" && req.method === "GET") return json(engine.status());

        if (route === "/api/warm" && req.method === "POST") {
            engine.warm();
            return json(engine.status());
        }

        if (route === "/api/voices" && req.method === "GET") return json({ voices: await engine.voices(), default: DEFAULT_VOICE });

        if (route === "/api/stt" && req.method === "POST") {
            const wav = decodeWav(new Uint8Array(await req.arrayBuffer()));
            const text = await engine.transcribe(resample(wav.samples, wav.sampleRate, 16000));
            return json({ text });
        }

        if (route === "/api/tts" && req.method === "POST") {
            const body = (await req.json()) as { text?: unknown; voice?: unknown; speed?: unknown };
            const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TTS_CHARS) : "";
            if (!text) return json({ error: "text required" }, 400);
            const voice = typeof body.voice === "string" && /^[a-z]{2}_[a-z]+$/.test(body.voice) ? body.voice : DEFAULT_VOICE;
            const speed = typeof body.speed === "number" && body.speed >= 0.5 && body.speed <= 2 ? body.speed : 1;
            const wav = await engine.synthesize(text, voice, speed);
            return new Response(wav, { headers: { ...CORS, "Content-Type": "audio/wav" } });
        }

        const live = route.match(/^\/api\/session\/([^/]+)\/live$/);
        if (live && req.method === "POST") {
            const { on } = (await req.json()) as { on?: unknown };
            if (!setLive(decodeURIComponent(live[1]!), on === true)) return json({ error: "bad session id" }, 400);
            return json({ ok: true });
        }
    } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }

    if (req.method === "GET" && route === path) {
        return new Response(indexHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return json({ error: "not found" }, 404);
}

/** Largest audio frame accepted from the browser: 2 s of 16 kHz PCM16. */
const MAX_FRAME_BYTES = 16000 * 2 * 2;
const STREAM_ROUTE = /\/api\/stt\/stream$/;

/**
 * Per-connection streaming STT state. One utterance at a time: `start` opens a
 * stream (cancelling any previous one), binary PCM16 frames feed it, `end`
 * asks for the final text. Events carry the client's utterance id so the
 * browser can ignore anything stale.
 */
export interface SocketState {
    engine: SpeechEngine;
    current?: { id: number; stream: SttStream };
    release?: () => void;
}

type Sock = Pick<ServerWebSocket<SocketState>, "data" | "send" | "close">;

export const sttSocket = {
    open(ws: Sock) {
        ws.data.release = ws.data.engine.retain();
        ws.data.engine.stt.warm().catch(() => {});
    },
    message(ws: Sock, msg: string | Buffer) {
        const st = ws.data;
        if (typeof msg !== "string") {
            if (!st.current) return;
            if (msg.byteLength > MAX_FRAME_BYTES || msg.byteLength % 2) return void ws.close(1009, "bad audio frame");
            const pcm16 = new Int16Array(msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength));
            const pcm = new Float32Array(pcm16.length);
            for (let i = 0; i < pcm16.length; i++) pcm[i] = pcm16[i]! / 32768;
            st.current.stream.audio(pcm);
            return;
        }
        let m: { type?: unknown; id?: unknown };
        try {
            m = JSON.parse(msg);
        } catch {
            return void ws.close(1003, "bad message");
        }
        if (m.type === "ping") return void ws.send(JSON.stringify({ type: "pong" }));
        const id = m.id;
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return;
        if (m.type === "start") {
            st.current?.stream.cancel();
            const send = (o: object) => {
                if (st.current?.id === id) ws.send(JSON.stringify({ ...o, id }));
            };
            st.current = {
                id,
                stream: st.engine.stt.open({
                    partial: (text) => send({ type: "partial", text: stripNonSpeech(text) }),
                    final: (text) => {
                        send({ type: "final", text: stripNonSpeech(text) });
                        if (st.current?.id === id) st.current = undefined;
                    },
                    error: (message) => {
                        send({ type: "error", message });
                        if (st.current?.id === id) st.current = undefined;
                    },
                }),
            };
        } else if (st.current?.id === id) {
            if (m.type === "end") st.current.stream.end();
            else if (m.type === "cancel") {
                st.current.stream.cancel();
                st.current = undefined;
            }
        }
    },
    close(ws: Sock) {
        ws.data.current?.stream.cancel();
        ws.data.current = undefined;
        ws.data.release?.();
    },
};

/** Serve HTTP routes plus the streaming STT WebSocket. Loopback only: the tunnel dials 127.0.0.1. */
export function serve(engine: SpeechEngine, indexHtml: string, port = 0): Server<SocketState> {
    return Bun.serve<SocketState, never>({
        hostname: "127.0.0.1",
        port,
        // idleTimeout: the first TTS call can wait on a model load well past Bun's 10s default.
        idleTimeout: 240,
        fetch(req, server) {
            if (STREAM_ROUTE.test(new URL(req.url).pathname) && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
                return server.upgrade(req, { data: { engine } }) ? undefined : json({ error: "upgrade failed" }, 400);
            }
            return handleRequest(req, engine, indexHtml);
        },
        websocket: {
            maxPayloadLength: MAX_FRAME_BYTES + 1024,
            idleTimeout: 120,
            open: (ws) => sttSocket.open(ws),
            message: (ws, msg) => sttSocket.message(ws, msg),
            close: (ws) => sttSocket.close(ws),
        },
    });
}

class LiveService {
    get id() {
        return "live";
    }
    #server: Server<SocketState> | null = null;
    #engine = new SpeechEngine();

    init(_socket: unknown, { announcePanel }: { announcePanel?: (port: number) => void }) {
        const indexHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "panel", "index.html"), "utf-8");
        this.#server = serve(this.#engine, indexHtml);
        announcePanel?.(this.#server.port!);
    }

    handleSessionEnded(sessionId: string) {
        setLive(sessionId, false);
    }

    dispose() {
        this.#server?.stop(true);
        this.#server = null;
        this.#engine.dispose();
    }
}

export default LiveService;
