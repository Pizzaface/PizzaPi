/**
 * `pizza config show` — read-only, prints the resolved effective config
 * (global ~/.pizzapi/config.json merged with project .pizzapi/config.json)
 * with secrets redacted. Never writes anything.
 */
import { defaultAgentDir, expandHome, loadConfig } from "./config.js";
import { c } from "./cli-colors.js";

const RELAY_DEFAULT = "ws://localhost:7492";

/** Redact an API key: "unset" if absent, "set" if too short to safely slice, else first4…last4. */
export function maskApiKey(key: string | undefined): string {
    if (!key) return "unset";
    if (key.length <= 8) return "set";
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
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
    console.log(`  ${c.dim("relayUrl")}    ${effectiveRelayUrl}${envRelayUrl ? c.dim("  (from PIZZAPI_RELAY_URL)") : ""}`);
    console.log(`  ${c.dim("agentDir")}    ${agentDir}`);
    console.log("");

    const redacted = { ...config, apiKey: maskApiKey(config.apiKey) };
    console.log(c.dim("Resolved config.json (secrets redacted):"));
    console.log(JSON.stringify(redacted, null, 2));
    console.log("");

    return 0;
}
