import { createInterface } from "readline";
import { homedir } from "os";
import { join } from "path";
import { saveGlobalConfig } from "./config.js";

const RELAY_DEFAULT = "http://localhost:7492";

function rl() {
    return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(iface: ReturnType<typeof rl>, question: string): Promise<string> {
    return new Promise((resolve) => iface.question(question, resolve));
}

function askPassword(question: string): Promise<string> {
    return new Promise((resolve) => {
        process.stdout.write(question);
        const iface = createInterface({ input: process.stdin, terminal: false });
        // Hide input by disabling echo via raw mode if available
        if (process.stdin.isTTY) {
            (process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }).setRawMode?.(true);
        }
        let password = "";
        process.stdin.on("data", function onData(chunk: Buffer) {
            const str = chunk.toString();
            for (const char of str) {
                if (char === "\r" || char === "\n") {
                    process.stdin.removeListener("data", onData);
                    if (process.stdin.isTTY) {
                        (process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }).setRawMode?.(false);
                    }
                    process.stdout.write("\n");
                    iface.close();
                    resolve(password);
                    return;
                } else if (char === "\x7f" || char === "\b") {
                    password = password.slice(0, -1);
                } else if (char === "\x03") {
                    // Ctrl+C
                    process.stdout.write("\n");
                    process.exit(1);
                } else {
                    password += char;
                }
            }
        });
    });
}

async function registerCli(
    relayUrl: string,
    name: string,
    email: string,
    password: string,
): Promise<{ ok: boolean; key?: string; error?: string }> {
    try {
        const res = await fetch(`${relayUrl}/api/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, email, password }),
        });
        const json = (await res.json()) as { ok?: boolean; key?: string; error?: string };
        if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
        return { ok: json.ok === true, key: json.key };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Interactive first-run setup.
 * Prompts for relay URL, email and password, authenticates with the server,
 * then saves the returned API key to ~/.pizzapi/config.json.
 *
 * Returns true if setup completed successfully, false if skipped/aborted.
 */
export async function runSetup(opts: { force?: boolean } = {}): Promise<boolean> {
    const iface = rl();

    try {
        const configPath = join(homedir(), ".pizzapi", "config.json");

        console.log("\n┌─────────────────────────────────────────┐");
        console.log("│        PizzaPi — first-run setup        │");
        console.log("└─────────────────────────────────────────┘\n");
        console.log("Connect this node to a PizzaPi relay server so your sessions");
        console.log("can be monitored from the web UI.\n");

        if (!opts.force) {
            const skip = await ask(iface, "Skip setup and continue without relay? [y/N] ");
            if (skip.trim().toLowerCase() === "y") {
                console.log("\nSkipping relay setup. Run `pizzapi setup` at any time to configure.\n");
                return false;
            }
        }

        // Relay URL
        const relayInput = await ask(
            iface,
            `Relay server URL [${RELAY_DEFAULT}]: `,
        );
        const relayUrl = (relayInput.trim() || RELAY_DEFAULT).replace(/\/$/, "");

        // Identity
        const name = (await ask(iface, "Your name (leave blank if account already exists): ")).trim();
        const email = (await ask(iface, "Email: ")).trim();
        if (!email) {
            console.log("\n✗ Email is required. Aborting setup.\n");
            return false;
        }

        // Close rl before switching to raw mode for password
        iface.close();

        const password = await askPassword("Password: ");
        if (!password) {
            console.log("\n✗ Password is required. Aborting setup.\n");
            return false;
        }

        process.stdout.write("\nConnecting to relay server… ");
        const result = await registerCli(relayUrl, name, email, password);
        if (!result.ok || !result.key) {
            console.log("✗\n");
            console.error(
                `Could not register with the relay server: ${result.error ?? "unknown error"}\n` +
                "Check that the server is running, your credentials are correct, and try again.\n",
            );
            return false;
        }
        console.log("✓\n");

        // Derive ws:// URL for the relay config
        const wsRelayUrl = relayUrl.replace(/^http/, "ws");

        // Save the server-issued API key
        saveGlobalConfig({ apiKey: result.key });
        process.env.PIZZAPI_API_KEY = result.key;
        process.env.PIZZAPI_RELAY_URL = wsRelayUrl;

        console.log(`✓ API key saved to ${configPath}`);
        console.log(`✓ Relay: ${wsRelayUrl}\n`);
        return true;
    } finally {
        try { iface.close(); } catch {}
    }
}
