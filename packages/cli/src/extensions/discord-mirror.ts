/**
 * Discord mirror extension — forwards each settled assistant turn to the
 * daemon-scoped `discord` runner service over `service_message`.
 *
 * This is the *outbound* half of the Discord bridge. The inbound half (Discord
 * message -> session) is owned by the service, which posts to
 * `/api/sessions/:id/trigger`. See the "connectivity services" section of
 * docs/customization/runner-services.mdx.
 *
 * The session deliberately knows nothing about Discord: it emits one envelope
 * per settled turn and the service drops it if this session has no mapped
 * thread. That keeps thread mapping in exactly one place (the service) instead
 * of duplicating it into every session.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
    getRelaySocket as getRelaySocketDefault,
    getRelaySessionId as getRelaySessionIdDefault,
} from "./remote.js";

/** Discord's hard limit is 2000 chars; the service re-chunks, this just bounds the payload. */
const MAX_MIRROR_CHARS = 8_000;

export interface DiscordMirrorDeps {
    getRelaySocket: typeof getRelaySocketDefault;
    getRelaySessionId: typeof getRelaySessionIdDefault;
    newId: () => string;
}

const defaultDeps: DiscordMirrorDeps = {
    getRelaySocket: getRelaySocketDefault,
    getRelaySessionId: getRelaySessionIdDefault,
    newId: randomUUID,
};

/**
 * Pull the text of the last assistant message out of a run's message list.
 * Mirrors the extraction in remote/lifecycle-handlers.ts.
 */
export function lastAssistantText(messages: unknown): string | null {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as any;
        if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
        const text = msg.content
            .filter((c: any) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string" && c.text)
            .map((c: any) => c.text as string)
            .join("\n")
            .trim();
        if (text) return text.length > MAX_MIRROR_CHARS ? `${text.slice(0, MAX_MIRROR_CHARS)}\n…(truncated)` : text;
    }
    return null;
}

export function createDiscordMirrorExtension(deps: DiscordMirrorDeps = defaultDeps): ExtensionFactory {
    return (pi) => {
        // agent_end fires after every attempt (including retried ones); hold the
        // text and only publish once agent_settled confirms the turn is final.
        let pending: string | null = null;

        pi.on("agent_end" as any, (event: any) => {
            const text = lastAssistantText(event?.messages);
            if (text) pending = text;
        });

        pi.on("agent_settled" as any, () => {
            const content = pending;
            pending = null;
            if (!content) return;

            const conn = deps.getRelaySocket();
            const sessionId = deps.getRelaySessionId();
            if (!conn || !sessionId) return;

            // ponytail: fire-and-forget, no requestId round-trip. A dropped mirror
            // is cosmetic; blocking the turn on Discord's availability is not.
            //
            // `id` exists because relay delivery to the runner is at-least-once:
            // emitToRunner() emits to the runner room AND to the local socket, and
            // a local runner is in both, so every envelope arrives twice. The
            // service dedupes on this id.
            try {
                conn.socket.emit("service_message" as any, {
                    serviceId: "discord",
                    type: "discord_post",
                    payload: { id: deps.newId(), sessionId, content },
                });
            } catch {
                // Relay socket mid-reconnect — skip this turn's mirror.
            }
        });
    };
}

export const discordMirrorExtension: ExtensionFactory = createDiscordMirrorExtension();
