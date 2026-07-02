/**
 * Wire tap for the Anthropic /v1/messages request, loadable in BOTH runtimes:
 *   - vanilla pi:  pi -e packages/cli/scripts/wire-tap.ts -p "hi"
 *   - pizza:       imported in-process by scripts/diff-pi-pizza.ts
 *
 * Must stay dependency-free so vanilla pi (which does not have this repo's
 * node_modules) can load it as an extension file.
 *
 * Env:
 *   WIRE_CAPTURE_OUT   — file to write the capture JSON to (required to capture)
 *   WIRE_CAPTURE_ABORT — "1" to short-circuit the request with a synthetic 400
 *                        after capturing, so no subscription tokens are spent
 */

import { appendFileSync } from "node:fs";

let installed = false;

function tokenFingerprint(v: string): string {
    const tok = v.replace(/^Bearer\s+/i, "");
    return `…${tok.slice(-6)}(len=${tok.length})`;
}

export function installWireTap(label: string): void {
    if (installed) return;
    installed = true;
    const outFile = process.env.WIRE_CAPTURE_OUT;
    if (!outFile) return;
    appendFileSync(outFile, JSON.stringify({ label, installedAt: new Date().toISOString(), marker: "wire-tap-installed", pid: process.pid }) + "\n");
    const abort = process.env.WIRE_CAPTURE_ABORT === "1";
    let orig = globalThis.fetch;

    const wrapped = (async (input: any, init?: any) => {
        const url = typeof input === "string" ? input : (input?.url ?? String(input));
        const isMessages = typeof url === "string"
            && url.includes("api.anthropic.com")
            && url.includes("/v1/messages");
        if (process.env.WIRE_CAPTURE_ALL === "1") {
            try { appendFileSync(outFile, JSON.stringify({ label, pid: process.pid, marker: "fetch-call", url: String(url).slice(0, 200) }) + "\n"); } catch {}
        }
        if (!isMessages) return orig(input, init);

        try {
            const headers = new Headers(init?.headers ?? (typeof input === "object" ? input.headers : undefined));
            const hdr: Record<string, string> = {};
            headers.forEach((v, k) => {
                hdr[k] = k.toLowerCase() === "authorization" ? tokenFingerprint(v) : v;
            });
            const rawBody = init?.body ?? (typeof input === "object" ? input.body : undefined);
            let body: unknown = null;
            if (typeof rawBody === "string") {
                try { body = JSON.parse(rawBody); } catch { body = { unparsed: rawBody.slice(0, 2000) }; }
            }
            // The stack proves WHICH module built this request (minimalcc-pi's
            // native transport vs pi-ai's built-in anthropic provider).
            const stack = (new Error().stack ?? "")
                .split("\n")
                .slice(2, 12)
                .map((l) => l.trim());
            const capture = {
                label,
                pid: process.pid,
                capturedAt: new Date().toISOString(),
                runtime: {
                    execPath: process.execPath,
                    argv: process.argv,
                    bun: (process.versions as any).bun ?? null,
                    node: process.versions.node,
                },
                url,
                method: init?.method ?? (typeof input === "object" ? input.method : "GET"),
                headers: hdr,
                bodyBytes: typeof rawBody === "string" ? Buffer.byteLength(rawBody) : null,
                body,
                stack,
            };
            appendFileSync(outFile, JSON.stringify(capture) + "\n");
        } catch {
            // never break the request because of the tap
        }

        if (abort) {
            return new Response(
                JSON.stringify({ type: "error", error: { type: "wire_tap_abort", message: "captured by wire-tap.ts; request not sent" } }),
                { status: 400, headers: { "content-type": "application/json" } },
            );
        }
        const response = await orig(input, init);
        if (isMessages) {
            try {
                let body: string | undefined;
                if (!response.ok) {
                    body = await response.clone().text().catch(() => undefined);
                }
                appendFileSync(outFile, JSON.stringify({
                    label,
                    pid: process.pid,
                    marker: "fetch-response",
                    url,
                    status: response.status,
                    statusText: response.statusText,
                    ...(body ? { body: body.slice(0, 2000) } : {}),
                }) + "\n");
            } catch { /* ignore */ }
        }
        return response;
    }) as typeof fetch;

    // The host replaces globalThis.fetch after startup (observed with vanilla
    // pi, ~right before the provider request). An accessor property survives
    // plain reassignment race-free: writes swap the delegate, reads keep
    // returning the wrap.
    Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        enumerable: true,
        get: () => wrapped,
        set: (fn) => {
            try {
                appendFileSync(outFile, JSON.stringify({
                    label,
                    pid: process.pid,
                    marker: "fetch-replaced-rewrapping",
                    at: new Date().toISOString(),
                    replacementName: fn?.name ?? null,
                    replacementSource: String(fn).slice(0, 200),
                }) + "\n");
            } catch { /* ignore */ }
            orig = fn;
        },
    });
}

// pi extension entry point (pi -e wire-tap.ts)
export default function wireTapExtension(_pi: unknown): void {
    installWireTap("pi");
}
