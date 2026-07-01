/**
 * Diagnostic: capture the ACTUAL outbound HTTP request to Anthropic's
 * /v1/messages endpoint (headers + body), so we can compare byte-for-byte what
 * PizzaPi sends vs what vanilla pi sends through the same claude-subscription
 * extension. The `before_provider_request` event payload is NOT the real wire
 * request (custom providers build their own via streamSimple), so we wrap
 * global fetch instead.
 *
 * ponytail: temporarily always-on for debugging the claude-subscription
 * routing/billing issue. Remove this extension once resolved.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logInfo } from "../runner/logger.js";

let fetchWrapped = false;

/** Redact a bearer token to a short, non-reversible fingerprint. */
function tokenFingerprint(auth: string | undefined): string {
    if (!auth) return "(none)";
    const tok = auth.replace(/^Bearer\s+/i, "");
    // last 6 chars + length — enough to tell "same token?" without leaking it.
    return `…${tok.slice(-6)}(len=${tok.length})`;
}

function summarizeBody(bodyText: string): Record<string, unknown> {
    let body: any;
    try { body = JSON.parse(bodyText); } catch { return { parseError: true, rawLen: bodyText.length }; }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
        if (k === "system") {
            const chars = Array.isArray(v)
                ? v.reduce((n, b: any) => n + (typeof b?.text === "string" ? b.text.length : 0), 0)
                : (typeof v === "string" ? v.length : 0);
            out.systemBlocks = Array.isArray(v) ? v.length : 1;
            out.systemChars = chars;
        } else if (k === "messages") {
            out.messageCount = Array.isArray(v) ? v.length : 0;
        } else if (k === "tools") {
            out.toolNames = Array.isArray(v) ? v.map((t: any) => t?.name).filter(Boolean) : [];
        } else {
            out[k] = v; // model, max_tokens, thinking, output_config, metadata, fallbacks, temperature, stream, …
        }
    }
    return out;
}

function wrapFetch(): void {
    if (fetchWrapped) return;
    fetchWrapped = true;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        try {
            const url = typeof input === "string" ? input : input?.url ?? String(input);
            if (typeof url === "string" && url.includes("api.anthropic.com") && url.includes("/v1/messages")) {
                const headers = new Headers(init?.headers ?? (typeof input === "object" ? input.headers : undefined));
                const hdr: Record<string, string> = {};
                headers.forEach((v, k) => { hdr[k] = k.toLowerCase() === "authorization" ? tokenFingerprint(v) : v; });
                let bodyText = "";
                const b = init?.body ?? (typeof input === "object" ? input.body : undefined);
                if (typeof b === "string") bodyText = b;
                logInfo("[anthropic-request] " + JSON.stringify({ url, headers: hdr, body: summarizeBody(bodyText) }));
            }
        } catch { /* never disrupt the request */ }
        return orig(input, init);
    }) as typeof fetch;
}

export function providerRequestLogExtension(_pi: ExtensionAPI): void {
    wrapFetch();
}
