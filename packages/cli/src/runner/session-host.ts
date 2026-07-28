import type { AgentSession, AgentSessionRuntime, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model, TextContent } from "@earendil-works/pi-ai/compat";

/**
 * SessionHost — the single control surface over a host-owned `AgentSessionRuntime`.
 *
 * Both the local TUI (`index.ts`) and the runner worker construct an
 * `AgentSessionRuntime`; today PizzaPi's remote extension can only reach session
 * controls through pi's `ExtensionAPI`, which is a strict subset of what the
 * runtime already exposes. That gap is bridged by patch hunks in
 * `patches/@earendil-works%2Fpi-coding-agent@0.82.1.patch` that copy host
 * capabilities down onto `ExtensionAPI`.
 *
 * SessionHost lets the host hand the remote layer a direct handle instead, so
 * those capabilities are called natively — no patch. It is a thin façade, not an
 * abstraction: it holds no state and adds no serialization (pi's agent already
 * serializes via its steering/follow-up queues).
 */
export type UserMessageContent = string | (TextContent | ImageContent)[];

export interface SendUserMessageOptions {
    deliverAs?: "steer" | "followUp";
    /** Opt into slash-command and prompt-template expansion (default false). */
    expandPromptTemplates?: boolean;
}

/**
 * Injected bridge for the one queue op with no public native equivalent.
 *
 * `replaceQueuedMessages` must repopulate the queue with ALREADY-expanded text,
 * which requires pi's private raw-enqueue (`_queueSteer`/`_queueFollowUp`). The
 * public `steer()`/`followUp()` re-run skill + template expansion, so rebuilding
 * the queue through them would double-expand. Until upstream exposes a public
 * raw-requeue primitive, the host wires this to the patched `ExtensionAPI`
 * runtime method.
 *
 * ponytail: one injected fn, not a layer — delete when upstream adds a public
 * requeue and call `session` directly.
 */
export type ReplaceQueuedMessagesFn = (followUp: string[]) => void;

export class SessionHost {
    constructor(
        private readonly runtime: AgentSessionRuntime,
        private readonly replaceQueuedMessagesFn?: ReplaceQueuedMessagesFn,
    ) {}

    /** Read the live session — `runtime.session` is replaced on new/switch/fork/import. */
    private get session(): AgentSession {
        return this.runtime.session;
    }

    get cwd(): string {
        return this.runtime.cwd;
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

    newSession(options?: Parameters<AgentSessionRuntime["newSession"]>[0]): ReturnType<AgentSessionRuntime["newSession"]> {
        return this.runtime.newSession(options);
    }

    switchSession(
        sessionPath: string,
        options?: Parameters<AgentSessionRuntime["switchSession"]>[1],
    ): ReturnType<AgentSessionRuntime["switchSession"]> {
        return this.runtime.switchSession(sessionPath, options);
    }

    fork(entryId: string, options?: Parameters<AgentSessionRuntime["fork"]>[1]): ReturnType<AgentSessionRuntime["fork"]> {
        return this.runtime.fork(entryId, options);
    }

    importFromJsonl(inputPath: string, cwdOverride?: string): ReturnType<AgentSessionRuntime["importFromJsonl"]> {
        return this.runtime.importFromJsonl(inputPath, cwdOverride);
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
