/**
 * Diagnostic: log which provider/api actually handles each outbound request,
 * plus the shape of what PizzaPi puts on the wire (system-block sizes, tool
 * names). Used to prove whether a turn routes through a custom provider's
 * native path (e.g. `claude-subscription-native`) or falls back to a built-in
 * API handler (e.g. `anthropic-messages`), and whether PizzaPi's system prompt
 * diverges from what the provider expects.
 *
 * Enabled only when PIZZAPI_LOG_PROVIDER_REQUEST is set (off by default so it
 * never adds log noise or per-request cost in normal operation).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logInfo } from "../runner/logger.js";

function isEnabled(): boolean {
    const v = process.env.PIZZAPI_LOG_PROVIDER_REQUEST;
    return !!v && !["0", "false", "no", "off"].includes(v.toLowerCase());
}

function summarizeSystem(system: unknown): { blocks: number; chars: number; firstBlock: string } {
    if (typeof system === "string") {
        return { blocks: 1, chars: system.length, firstBlock: system.slice(0, 60) };
    }
    if (Array.isArray(system)) {
        let chars = 0;
        for (const b of system) {
            const t = b && typeof b === "object" ? (b as { text?: unknown }).text : undefined;
            if (typeof t === "string") chars += t.length;
        }
        const first = system[0] && typeof system[0] === "object" ? (system[0] as { text?: unknown }).text : undefined;
        return { blocks: system.length, chars, firstBlock: typeof first === "string" ? first.slice(0, 60) : "" };
    }
    return { blocks: 0, chars: 0, firstBlock: "" };
}

export function providerRequestLogExtension(pi: ExtensionAPI): void {
    if (!isEnabled()) return;

    pi.on("before_provider_request", (event, ctx) => {
        try {
            const model = (ctx as { model?: { provider?: string; id?: string; api?: string } }).model;
            const payload = event.payload as { model?: unknown; system?: unknown; tools?: unknown[] } | undefined;
            const sys = summarizeSystem(payload?.system);
            const tools = Array.isArray(payload?.tools) ? payload!.tools : [];
            const toolNames = tools
                .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : undefined))
                .filter((n): n is string => typeof n === "string");

            logInfo(
                "[provider-request] " +
                    JSON.stringify({
                        provider: model?.provider,
                        api: model?.api,
                        modelId: model?.id,
                        payloadModel: payload?.model,
                        systemBlocks: sys.blocks,
                        systemChars: sys.chars,
                        systemFirstBlock: sys.firstBlock,
                        toolCount: toolNames.length,
                        toolNames: toolNames.slice(0, 40),
                    }),
            );
        } catch {
            // Diagnostic only — never disrupt the request.
        }
    });
}
