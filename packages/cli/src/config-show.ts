/**
 * `pizza config show` — read-only, prints the resolved effective config
 * (global ~/.pizzapi/config.json merged with project .pizzapi/config.json)
 * with secrets redacted. Never writes anything.
 */
import { defaultAgentDir, expandHome, loadConfig } from "./config.js";
import { c } from "./cli-colors.js";

const RELAY_DEFAULT = "ws://localhost:7492";

/** Redact an API key: "unset" if absent, "set" for non-strings or too-short values, else first4…last4. Accepts unknown because config JSON is loaded unvalidated. */
export function maskApiKey(key: unknown): string {
    if (key === undefined || key === null || key === "") return "unset";
    if (typeof key !== "string") return "set";
    if (key.length <= 8) return "set";
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

const REDACTED = "«redacted»";
/** Key names whose value is a secret and must never be printed. */
const SECRET_KEY_RE = /(secret|token|password|passwd|cookie|bearer|credential|private[_-]?key)/i;
/** Key names that hold a map of arbitrary values (each of which may be a secret). */
const OPAQUE_MAP_KEYS = new Set(["env", "envoverrides", "headers"]);

/**
 * Recursively redact a config object for display: masks apiKey-style fields,
 * fully redacts secret-named keys and env/header maps, and strips embedded
 * userinfo from every URL-shaped string. Never mutates the input.
 */
export function deepRedactConfig(value: unknown): unknown {
    if (typeof value === "string") return maskUrlUserinfo(value) ?? value;
    if (Array.isArray(value)) return value.map(deepRedactConfig);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const lower = k.toLowerCase();
            if (lower === "apikey" || lower.endsWith("apikey")) {
                out[k] = v == null ? v : maskApiKey(v);
            } else if (OPAQUE_MAP_KEYS.has(lower)) {
                out[k] = v && typeof v === "object" && !Array.isArray(v)
                    ? Object.fromEntries(Object.keys(v as object).map((ek) => [ek, REDACTED]))
                    : (v == null ? v : REDACTED);
            } else if (SECRET_KEY_RE.test(k)) {
                out[k] = v == null ? v : REDACTED;
            } else {
                out[k] = deepRedactConfig(v);
            }
        }
        return out;
    }
    return value;
}

/** Strip embedded userinfo (user:pass@) from a URL so credentials aren't printed. Non-URL strings pass through unchanged. */
export function maskUrlUserinfo(url: string | undefined): string | undefined {
    if (!url) return url;
    try {
        const u = new URL(url);
        if (u.username || u.password) {
            u.username = "";
            u.password = "";
            return u.toString();
        }
        return url;
    } catch {
        // Not a parseable URL (e.g. "off") — return as-is.
        return url;
    }
}

export function runConfigShowCommand(cwd: string = process.cwd()): number {
    const config = loadConfig(cwd);
    const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();

    const envApiKey = process.env.PIZZAPI_API_KEY;
    const envRelayUrl = process.env.PIZZAPI_RELAY_URL;
    const effectiveApiKey = envApiKey ?? config.apiKey;
    const effectiveRelayUrl = envRelayUrl ?? config.relayUrl ?? RELAY_DEFAULT;

    console.log("");
    console.log(c.label("Effective PizzaPi config") + c.dim(`  (${cwd})`));
    console.log("");
    console.log(`  ${c.dim("apiKey")}      ${maskApiKey(effectiveApiKey)}${envApiKey ? c.dim("  (from PIZZAPI_API_KEY)") : ""}`);
    console.log(`  ${c.dim("relayUrl")}    ${maskUrlUserinfo(effectiveRelayUrl)}${envRelayUrl ? c.dim("  (from PIZZAPI_RELAY_URL)") : ""}`);
    console.log(`  ${c.dim("agentDir")}    ${agentDir}`);
    console.log("");

    const redacted = deepRedactConfig(config);
    console.log(c.dim("Resolved config.json (secrets redacted):"));
    console.log(JSON.stringify(redacted, null, 2));
    console.log("");

    return 0;
}
