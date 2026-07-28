import type { AgentSession, AgentSessionRuntime, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai/compat";

/**
 * SessionHost — the single session-control surface PizzaPi's remote extension
 * drives, decoupled from pi's `ExtensionAPI`.
 *
 * The pi-coding-agent 0.82.1 patch copies session-control capabilities onto
 * `ExtensionAPI` (`newSession`/`switchSession`/`fork`, `getQueuedMessages`/
 * `replaceQueuedMessages`, `sendUserMessage({expandPromptTemplates})`) purely so
 * the remote extension — which runs in event handlers and only sees
 * `ExtensionAPI` — can reach them. Threading a `SessionHost` into the remote
 * context lets those call sites use a direct handle instead, removing the
 * patch's reason to exist.
 *
 * The two hosts differ only in session *lifecycle*:
 *  - Local TUI: an `AgentSessionRuntime` provides new/switch/fork natively
 *    (tears down + recreates the session).
 *  - Runner worker: headless in-place actions swap the contents of one
 *    long-lived `AgentSession` (so the relay connection survives).
 *
 * Everything else operates on the current `AgentSession`, so `SessionHost` is
 * parameterized by a session accessor + a lifecycle object rather than
 * subclassed. It holds no state and adds no serialization (pi's agent already
 * serializes via its steering/follow-up queues).
 */
export type UserMessageContent = string | (TextContent | ImageContent)[];

export interface SendUserMessageOptions {
    deliverAs?: "steer" | "followUp";
    /** Opt into slash-command and prompt-template expansion (default false). */
    expandPromptTemplates?: boolean;
}

/** Session lifecycle operations — backed by the runtime (TUI) or custom worker actions. */
export interface SessionLifecycle {
    newSession(options?: Parameters<AgentSessionRuntime["newSession"]>[0]): Promise<{ cancelled: boolean }>;
    switchSession(
        sessionPath: string,
        options?: Parameters<AgentSessionRuntime["switchSession"]>[1],
    ): Promise<{ cancelled: boolean }>;
    fork(
        entryId: string,
        options?: Parameters<AgentSessionRuntime["fork"]>[1],
    ): Promise<{ cancelled: boolean; selectedText?: string }>;
    /** Only the runtime host supports import; optional for headless. */
    importFromJsonl?(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>;
}

/**
 * Injected bridge for the one queue op with no public native equivalent.
 *
 * `replaceQueuedMessages` must repopulate the queue with ALREADY-expanded text,
 * which requires pi's private raw-enqueue (`_queueSteer`/`_queueFollowUp`). The
 * public `steer()`/`followUp()` re-run skill + template expansion, so rebuilding
 * the queue through them would double-expand. Each host supplies its own bridge
 * (the worker reaches the private methods directly, as it already does for queue
 * clearing).
 *
 * ponytail: one injected fn, not a layer — delete when upstream adds a public
 * raw-requeue primitive.
 */
export type ReplaceQueuedMessagesFn = (followUp: string[]) => void;

export class SessionHost {
    constructor(
        private readonly getSession: () => AgentSession,
        private readonly lifecycle: SessionLifecycle,
        private readonly replaceQueuedMessagesFn?: ReplaceQueuedMessagesFn,
    ) {}

    /** Read the live session — it is replaced (TUI) or mutated in place (worker). */
    private get session(): AgentSession {
        return this.getSession();
    }

    get pendingMessageCount(): number {
        return this.session.pendingMessageCount;
    }

    /**
     * Deliver a user message. Mirrors pi's `ExtensionAPI.sendUserMessage` content
     * normalization (text parts joined with newlines, images collected) and maps
     * to `session.prompt`, which is what the patched handler does internally.
     */
    async sendUserMessage(content: UserMessageContent, options?: SendUserMessageOptions): Promise<void> {
        let text: string;
        let images: ImageContent[] | undefined;
        if (typeof content === "string") {
            text = content;
        } else {
            const textParts: string[] = [];
            images = [];
            for (const part of content) {
                if (part.type === "text") {
                    textParts.push(part.text);
                } else {
                    images.push(part);
                }
            }
            text = textParts.join("\n");
            if (images.length === 0) {
                images = undefined;
            }
        }
        const promptOptions: PromptOptions = {
            expandPromptTemplates: options?.expandPromptTemplates ?? false,
            streamingBehavior: options?.deliverAs,
            images,
            source: "extension",
        };
        await this.session.prompt(text, promptOptions);
    }

    /** Snapshot of the pending steering/follow-up queues (defensively copied). */
    getQueuedMessages(): { steering: string[]; followUp: string[] } {
        return {
            steering: [...this.session.getSteeringMessages()],
            followUp: [...this.session.getFollowUpMessages()],
        };
    }

    /**
     * Replace the pending follow-up queue. Delegates to the injected bridge — see
     * {@link ReplaceQueuedMessagesFn} for why there is no public native path.
     */
    replaceQueuedMessages(followUp: string[]): void {
        if (!this.replaceQueuedMessagesFn) {
            throw new Error(
                "SessionHost.replaceQueuedMessages requires a queue bridge: pi exposes no public " +
                    "raw-requeue primitive, and rebuilding the queue via steer()/followUp() would " +
                    "double-expand already-expanded queued text.",
            );
        }
        this.replaceQueuedMessagesFn(followUp);
    }

    newSession(options?: Parameters<SessionLifecycle["newSession"]>[0]): Promise<{ cancelled: boolean }> {
        return this.lifecycle.newSession(options);
    }

    switchSession(
        sessionPath: string,
        options?: Parameters<SessionLifecycle["switchSession"]>[1],
    ): Promise<{ cancelled: boolean }> {
        return this.lifecycle.switchSession(sessionPath, options);
    }

    fork(
        entryId: string,
        options?: Parameters<SessionLifecycle["fork"]>[1],
    ): Promise<{ cancelled: boolean; selectedText?: string }> {
        return this.lifecycle.fork(entryId, options);
    }

    importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
        if (!this.lifecycle.importFromJsonl) {
            throw new Error("SessionHost: importFromJsonl is not supported by this host");
        }
        return this.lifecycle.importFromJsonl(inputPath, cwdOverride);
    }

    abort(): Promise<void> {
        return this.session.abort();
    }

    waitForIdle(): Promise<void> {
        return this.session.waitForIdle();
    }

    setModel(model: Model<any>): Promise<void> {
        return this.session.setModel(model);
    }
}

/**
 * Build a SessionHost backed by an `AgentSessionRuntime` (local TUI). Lifecycle
 * ops delegate to the runtime, which recreates the session on each transition.
 */
export function runtimeSessionHost(
    runtime: AgentSessionRuntime,
    replaceQueuedMessagesFn?: ReplaceQueuedMessagesFn,
): SessionHost {
    return new SessionHost(
        () => runtime.session,
        {
            newSession: (o) => runtime.newSession(o),
            switchSession: (p, o) => runtime.switchSession(p, o),
            fork: (e, o) => runtime.fork(e, o),
            importFromJsonl: (p, c) => runtime.importFromJsonl(p, c),
        },
        replaceQueuedMessagesFn,
    );
}
