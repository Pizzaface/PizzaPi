import * as React from "react";
import { createPortal } from "react-dom";
import { Mic, MicOff, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLiveVoice, type LivePhase, type LiveVoiceOptions } from "@/lib/live-voice/useLiveVoice";
import { describeActiveTools } from "@/lib/live-voice/tool-activity";

const PHASE_LABEL: Record<LivePhase, string> = {
    starting: "",
    listening: "Listening",
    hearing: "Listening",
    transcribing: "Got it…",
    thinking: "Working…",
    speaking: "Speaking",
    error: "Something went wrong",
};

export function LiveOverlay({ onClose, sessionName, ...opts }: LiveVoiceOptions & { onClose(): void; sessionName?: string }) {
    const live = useLiveVoice(opts);
    const orbRef = React.useRef<HTMLDivElement>(null);

    // Drive the orb straight from the audio level, without re-rendering.
    React.useEffect(() => {
        let raf = 0;
        let smooth = 0;
        const tick = () => {
            smooth += ((live.levelRef.current ?? 0) - smooth) * 0.25;
            if (orbRef.current) orbRef.current.style.transform = `scale(${1 + smooth * 0.35})`;
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [live.levelRef]);

    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const label = live.phase === "starting" ? live.status : live.muted ? "Muted" : PHASE_LABEL[live.phase];
    const activeWork = live.phase === "thinking" ? describeActiveTools(opts.activeToolCalls?.values() ?? []) : null;

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Live voice chat"
            className="fixed inset-0 z-[100] flex flex-col bg-background text-foreground pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        >
            <div className="flex items-center justify-between px-4 py-3">
                <span className="truncate text-sm text-muted-foreground">{sessionName || "Live"}</span>
                <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-red-500">Live</span>
            </div>

            <div className="flex flex-1 flex-col items-center justify-center gap-10 px-6">
                <div className="relative flex size-48 items-center justify-center">
                    <div
                        ref={orbRef}
                        className={cn(
                            "size-40 rounded-full transition-[background,opacity] duration-500 will-change-transform",
                            live.phase === "speaking"
                                ? "bg-gradient-to-br from-sky-400 to-indigo-600"
                                : live.phase === "thinking" || live.phase === "transcribing"
                                  ? "animate-pulse bg-gradient-to-br from-indigo-400 to-fuchsia-600"
                                  : live.phase === "error"
                                    ? "bg-gradient-to-br from-red-400 to-red-700"
                                    : live.phase === "starting"
                                      ? "animate-pulse bg-muted"
                                      : "bg-gradient-to-br from-zinc-200 to-zinc-400 dark:from-zinc-500 dark:to-zinc-700",
                            live.muted && "opacity-40",
                        )}
                    />
                </div>

                <div className="flex min-h-28 w-full max-w-md flex-col items-center gap-3 text-center" aria-live="polite">
                    <p className="text-sm font-medium text-muted-foreground">{label}</p>
                    {activeWork && <p className="text-xs text-muted-foreground">{activeWork}</p>}
                    {live.error ? (
                        <p className="text-sm text-destructive">{live.error}</p>
                    ) : (
                        <>
                            {live.userCaption && <p className="line-clamp-2 text-sm text-muted-foreground">“{live.userCaption}”</p>}
                            {live.agentCaption && <p className="line-clamp-3 text-lg leading-snug">{live.agentCaption}</p>}
                        </>
                    )}
                </div>
            </div>

            <div className="flex items-center justify-center gap-8 pb-8">
                <button
                    type="button"
                    onClick={() => live.setMuted(!live.muted)}
                    disabled={live.phase === "starting" || live.phase === "error"}
                    aria-pressed={live.muted}
                    aria-label={live.muted ? "Unmute microphone" : "Mute microphone"}
                    className={cn(
                        "flex size-16 items-center justify-center rounded-full border transition-colors disabled:opacity-40",
                        live.muted ? "border-foreground bg-foreground text-background" : "border-border bg-muted/50 hover:bg-muted",
                    )}
                >
                    {live.muted ? <MicOff className="size-6" /> : <Mic className="size-6" />}
                </button>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="End voice chat"
                    className="flex size-16 items-center justify-center rounded-full bg-red-600 text-white transition-colors hover:bg-red-700"
                >
                    <X className="size-7" />
                </button>
            </div>
        </div>,
        document.body,
    );
}
