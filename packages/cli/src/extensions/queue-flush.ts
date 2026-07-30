import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Rescue for stranded queued messages.
 *
 * pi's agent loop drains the steering/follow-up queues once, just before it
 * emits agent_end — but the session keeps reporting `isStreaming` until
 * agent_settled. Anything queued in that window (relay triggers, web UI input,
 * subagent results) lands in a queue nothing will ever drain again: queues are
 * only pulled from inside a run, and no run is starting. The session looks
 * finished while a message sits waiting — the conversation stalls.
 *
 * If we settle with messages still queued, kick one turn. Steering drains at
 * the start of that run, follow-ups at the end, so the stranded content lands
 * either way.
 */

const MAX_CONSECUTIVE_KICKS = 3;

export const queueFlushExtension: ExtensionFactory = (pi) => {
    let kicks = 0;

    pi.on("agent_settled", (_event: any, ctx: any) => {
        if (!ctx?.hasPendingMessages?.()) {
            kicks = 0;
            return;
        }
        // ponytail: cap the kicks — if a queue somehow never drains, stall beats spin.
        if (kicks >= MAX_CONSECUTIVE_KICKS) return;
        kicks += 1;
        // Deferred: agent_settled handlers are still running, and starting a run
        // from inside one re-enters the session's run state.
        setTimeout(() => {
            pi.sendMessage(
                {
                    customType: "queue-flush",
                    content: "(resuming: messages were queued after the turn ended)",
                    display: false,
                } as any,
                { triggerTurn: true } as any,
            );
        }, 0);
    });
};
