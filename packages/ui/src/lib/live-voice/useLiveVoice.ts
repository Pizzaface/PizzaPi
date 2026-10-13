import * as React from "react";
import { resolveTunnelTarget } from "@/hooks/useTunnelSrc";
import { PlaybackQueue, startMic } from "./audio";
import { replyText, SpeechChunker } from "./speech";

export type LivePhase = "starting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking" | "error";

export interface LiveVoiceOptions {
    /** Unlocked in the Live button's click handler (iOS requires a user gesture). */
    audioContext: AudioContext;
    sessionId: string;
    runnerId?: string;
    /** Port of the runner's `live` service. */
    port: number;
    messages: ReadonlyArray<{ role: string; content?: unknown }>;
    agentActive: boolean;
    send(text: string, steer: boolean): Promise<boolean> | boolean;
    voice?: string;
}

export interface LiveVoiceState {
    phase: LivePhase;
    muted: boolean;
    setMuted(m: boolean): void;
    userCaption: string;
    agentCaption: string;
    /** e.g. "Downloading voice models… 42%" while starting. */
    status: string;
    error: string | null;
    /** Current loudness 0–1 (mic while listening, voice while speaking), for animation. */
    levelRef: React.RefObject<number>;
}

const HEARTBEAT_MS = 30_000;

export function useLiveVoice(o: LiveVoiceOptions): LiveVoiceState {
    const [base, setBase] = React.useState<URL | null>(null);
    const [ready, setReady] = React.useState(false);
    const [status, setStatus] = React.useState("Connecting…");
    const [error, setError] = React.useState<string | null>(null);
    const [hearing, setHearing] = React.useState(false);
    const [transcribing, setTranscribing] = React.useState(false);
    const [playing, setPlaying] = React.useState(false);
    const [muted, setMutedState] = React.useState(false);
    const [userCaption, setUserCaption] = React.useState("");
    const [agentCaption, setAgentCaption] = React.useState("");
    const levelRef = React.useRef(0);

    // Latest props for audio callbacks that outlive renders.
    const live = React.useRef(o);
    live.current = o;
    const queueRef = React.useRef<PlaybackQueue | null>(null);
    const micRef = React.useRef<Awaited<ReturnType<typeof startMic>> | null>(null);
    const chunkerRef = React.useRef<SpeechChunker | null>(null);
    const silencedRef = React.useRef(false);

    // 1. Resolve the tunnel to the live service.
    React.useEffect(() => {
        const ac = new AbortController();
        resolveTunnelTarget({ sessionId: o.sessionId, runnerId: o.runnerId, port: o.port }, ac.signal)
            .then(({ href }) => setBase(new URL(href.endsWith("/") ? href : `${href}/`, window.location.href)))
            .catch((e: unknown) => !ac.signal.aborted && setError(`Can't reach the voice service: ${e instanceof Error ? e.message : e}`));
        return () => ac.abort();
    }, [o.sessionId, o.runnerId, o.port]);

    const api = React.useCallback((path: string, init?: RequestInit) => fetch(new URL(path, base!), init), [base]);

    // 2. Load models, mark the session live (heartbeat), open the mic.
    React.useEffect(() => {
        if (!base) return;
        let cancelled = false;
        const markLive = (on: boolean) =>
            api(`api/session/${encodeURIComponent(o.sessionId)}/live`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ on }),
                keepalive: !on,
            }).catch(() => {});
        void markLive(true);
        const heartbeat = setInterval(() => void markLive(true), HEARTBEAT_MS);

        void (async () => {
            try {
                await api("api/warm", { method: "POST" });
                for (;;) {
                    const s = (await (await api("api/status")).json()) as { stt: string; tts: string; progress: Record<string, number>; error?: string };
                    if (cancelled) return;
                    if (s.stt === "error" || s.tts === "error") throw new Error(s.error ?? "voice models failed to load");
                    if (s.stt === "ready" && s.tts === "ready") break;
                    const pct = Object.values(s.progress);
                    setStatus(pct.length ? `Downloading voice models… ${Math.round(pct.reduce((a, b) => a + b, 0) / pct.length)}%` : "Loading voice models…");
                    await new Promise((r) => setTimeout(r, 1000));
                }
                if (cancelled) return;
                setReady(true);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            }
        })();

        return () => {
            cancelled = true;
            clearInterval(heartbeat);
            void markLive(false);
        };
    }, [base, api, o.sessionId]);

    const speak = React.useCallback(
        (sentence: string) => {
            queueRef.current?.enqueue(async () => {
                const r = await api("api/tts", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: sentence, voice: live.current.voice }),
                });
                if (!r.ok) throw new Error(`tts ${r.status}`);
                return r.arrayBuffer();
            }, () => setAgentCaption(sentence));
        },
        [api],
    );

    // 3. Mic + playback, once models are ready.
    React.useEffect(() => {
        if (!ready) return;
        const ctx = o.audioContext;
        const queue = new PlaybackQueue(
            ctx,
            () => setPlaying(false),
            () => setPlaying(true),
        );
        queueRef.current = queue;
        let stopped = false;
        let silencedBeforeBargeIn = false;

        startMic(ctx, {
            isPlaying: () => queue.playing,
            onLevel: (l) => {
                if (!queue.playing) levelRef.current = Math.min(1, l * 8);
            },
            onSpeechStart: () => {
                setHearing(true);
                // Barge-in: the user talking always wins over the agent talking.
                silencedBeforeBargeIn = silencedRef.current;
                silencedRef.current = true;
                queue.clear();
            },
            onDiscard: () => {
                setHearing(false);
                silencedRef.current = silencedBeforeBargeIn;
            },
            onSpeechEnd: async (wav) => {
                setHearing(false);
                setTranscribing(true);
                try {
                    const r = await api("api/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
                    const { text, error: err } = (await r.json()) as { text?: string; error?: string };
                    if (!r.ok) throw new Error(err ?? `stt ${r.status}`);
                    if (!text) {
                        silencedRef.current = silencedBeforeBargeIn;
                        return;
                    }
                    setUserCaption(text);
                    setAgentCaption("");
                    silencedRef.current = false;
                    // Don't hold the "transcribing" phase open for the delivery ack.
                    setTranscribing(false);
                    if (!(await live.current.send(text, live.current.agentActive))) setUserCaption(`${text} (not sent)`);
                } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                } finally {
                    setTranscribing(false);
                }
            },
        }).then(
            (mic) => {
                if (stopped) mic.stop();
                else micRef.current = mic;
            },
            (e: unknown) => setError(e instanceof DOMException && e.name === "NotAllowedError" ? "Microphone access was denied." : String(e)),
        );

        let raf = 0;
        const tick = () => {
            if (queue.playing) levelRef.current = Math.min(1, queue.level() * 4);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);

        return () => {
            stopped = true;
            cancelAnimationFrame(raf);
            queue.clear();
            micRef.current?.stop();
            micRef.current = null;
            queueRef.current = null;
        };
    }, [ready, api, o.audioContext]);

    // 4. Speak new sentences of the reply as they stream in.
    React.useEffect(() => {
        const text = replyText(o.messages);
        if (!chunkerRef.current) {
            // Opening Live mid-reply: don't read out what's already on screen.
            chunkerRef.current = new SpeechChunker();
            chunkerRef.current.flush(text);
            return;
        }
        const c = chunkerRef.current;
        const sentences = o.agentActive ? c.push(text) : [...c.push(text), ...c.flush(text)];
        if (!ready || silencedRef.current) return;
        for (const s of sentences) speak(s);
    }, [o.messages, o.agentActive, ready, speak]);

    React.useEffect(() => () => void o.audioContext.close().catch(() => {}), [o.audioContext]);

    const setMuted = React.useCallback((m: boolean) => {
        setMutedState(m);
        micRef.current?.setMuted(m);
    }, []);

    const phase: LivePhase = error
        ? "error"
        : !ready
          ? "starting"
          : hearing
            ? "hearing"
            : transcribing
              ? "transcribing"
              : playing
                ? "speaking"
                : o.agentActive
                  ? "thinking"
                  : "listening";

    return { phase, muted, setMuted, userCaption, agentCaption, status, error, levelRef };
}
