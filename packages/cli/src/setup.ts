import { createInterface } from "readline";
import { homedir } from "os";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { saveGlobalConfig } from "./config.js";
import { validatePassword, PASSWORD_REQUIREMENTS } from "@pizzapi/protocol";
import { createLogger } from "@pizzapi/tools";
import { c } from "./cli-colors.js";
import qrcode from "qrcode";

const log = createLogger("setup");
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

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createSetupClaim(relayUrl: string): Promise<{ token: string; expiresAt: string } | { error: string }> {
    try {
        const res = await fetch(`${relayUrl}/api/setup-claim`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ relayUrl }),
        });
        const json = (await res.json()) as { token?: string; expiresAt?: string; error?: string };
        if (!res.ok || !json.token) return { error: json.error ?? `HTTP ${res.status}` };
        return { token: json.token, expiresAt: json.expiresAt ?? "" };
    } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
    }
}

async function pollSetupClaim(relayUrl: string, token: string): Promise<
    { status: string; apiKey?: string; relayUrl?: string } | { error: string }
> {
    try {
        const res = await fetch(`${relayUrl}/api/setup-claim/${token}`);
        const json = (await res.json()) as {
            status?: string;
            apiKey?: string;
            relayUrl?: string;
            error?: string;
        };
        if (!res.ok) return { error: json.error ?? `HTTP ${res.status}` };
        return { status: json.status ?? "unknown", apiKey: json.apiKey, relayUrl: json.relayUrl };
    } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
    }
}

export function qrCodeUrl(relayUrl: string, token: string): string {
    return `${relayUrl}/setup-claim?t=${encodeURIComponent(token)}`;
}

export async function runQrSetup(relayUrl: string, pollIntervalMs = 2000): Promise<boolean> {
    const configPath = join(homedir(), ".pizzapi", "config.json");

    process.stdout.write(`\n${c.dim("Creating setup claim…")} `);
    const claim = await createSetupClaim(relayUrl);
    if ("error" in claim) {
        log.info(c.error("✗") + "\n");
        log.error(`Could not create setup claim: ${claim.error}\n`);
        return false;
    }
    log.info(c.success("✓") + "\n");

    const claimUrl = qrCodeUrl(relayUrl, claim.token);
    const wsRelayUrl = relayUrl.replace(/^http/, "ws");

    log.info("Scan this QR code with an authenticated PizzaPi web browser:");
    log.info("");
    try {
        const qr = await qrcode.toString(claimUrl, { type: "terminal", small: true });
        log.info(qr);
    } catch (err) {
        log.warn("Could not render QR code; use the URL below.", err instanceof Error ? err.message : String(err));
    }
    log.info(c.dim("Or open:"), c.accent(claimUrl));
    log.info("");
    log.info(c.dim("Waiting for approval… (expires in 10 minutes)"));

    const startedAt = Date.now();
    const maxWaitMs = 10 * 60 * 1000;

    while (Date.now() - startedAt < maxWaitMs) {
        await sleep(pollIntervalMs);
        const result = await pollSetupClaim(relayUrl, claim.token);
        if ("error" in result) {
            log.warn(`Poll failed: ${result.error}`);
            continue;
        }
        if (result.status === "approved" && result.apiKey) {
            saveGlobalConfig({ apiKey: result.apiKey, relayUrl: wsRelayUrl });
            process.env.PIZZAPI_API_KEY = result.apiKey;
            process.env.PIZZAPI_RELAY_URL = wsRelayUrl;

            log.info("");
            log.info(`${c.success("✓")} Device approved`);
            log.info(`${c.success("✓")} API key saved to ${c.dim(configPath)}`);
            log.info(`${c.success("✓")} Relay: ${c.accent(wsRelayUrl)}\n`);
            return true;
        }
        if (result.status === "expired" || result.status === "redeemed") {
            log.info("");
            log.error(`Setup claim ${result.status}. Please try again.\n`);
            return false;
        }
    }

    log.info("");
    log.error("Setup claim expired before approval. Please try again.\n");
    return false;
}

/**
 * Interactive first-run setup.
 * Prompts for relay URL, email and password, authenticates with the server,
 * then saves the returned API key to ~/.pizzapi/config.json.
 *
 * Returns true if setup completed successfully, false if skipped/aborted.
 */
export async function runSetup(opts: { force?: boolean; scan?: boolean } = {}): Promise<boolean> {
    const iface = rl();

    try {
        const configPath = join(homedir(), ".pizzapi", "config.json");

        const frame = c.label("─".repeat(43));
        log.info("");
        log.info(c.label("┌") + frame + c.label("┐"));
        log.info(c.label("│") + `     ${c.brand("🍕 PizzaPi")} ${c.dim("— first-run setup")}     ` + c.label("│"));
        log.info(c.label("└") + frame + c.label("┘"));
        log.info("");
        log.info("Connect this node to a PizzaPi relay server so your sessions");
        log.info("can be monitored from the web UI.");
        log.info("");

        if (!opts.force) {
            const skip = await ask(iface, "Skip setup and continue without relay? [y/N] ");
            if (skip.trim().toLowerCase() === "y") {
                log.info("\nSkipping relay setup. Run `pizzapi setup` at any time to configure.\n");
                return false;
            }
        }

        // QR-code setup path
        if (opts.scan) {
            const relayInput = await ask(iface, `Relay server URL [${RELAY_DEFAULT}]: `);
            const relayUrl = (relayInput.trim() || RELAY_DEFAULT).replace(/\/$/, "");
            return await runQrSetup(relayUrl, process.env.CI ? 100 : 2000);
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
            log.info(`\n${c.error("✗")} Email is required. Aborting setup.\n`);
            return false;
        }

        // Close rl before switching to raw mode for password
        iface.close();

        const password = await askPassword("Password: ");
        if (!password) {
            log.info(`\n${c.error("✗")} Password is required. Aborting setup.\n`);
            return false;
        }

        // Validate password requirements for new accounts.
        if (name) {
            const check = validatePassword(password);
            if (!check.valid) {
                log.info(`\n${c.error("✗")} Password does not meet the requirements:`);
                for (const chk of check.checks) {
                    const icon = chk.met ? c.success("✓") : c.error("✗");
                    log.info(`  ${icon} ${chk.label}`);
                }
                log.info("");
                return false;
            }
        }

        process.stdout.write(`\n${c.dim("Connecting to relay server…")} `);
        const result = await registerCli(relayUrl, name, email, password);
        if (!result.ok || !result.key) {
            log.info(c.error("✗") + "\n");
            log.error(
                `Could not register with the relay server: ${result.error ?? "unknown error"}\n` +
                "Check that the server is running, your credentials are correct, and try again.\n",
            );
            return false;
        }
        log.info(c.success("✓") + "\n");

        // Derive ws:// URL for the relay config
        const wsRelayUrl = relayUrl.replace(/^http/, "ws");

        // Save the server-issued API key alongside the relay it was issued for —
        // otherwise a later run would fall back to the default relay while auth
        // silently points at a different server.
        saveGlobalConfig({ apiKey: result.key, relayUrl: wsRelayUrl });
        process.env.PIZZAPI_API_KEY = result.key;
        process.env.PIZZAPI_RELAY_URL = wsRelayUrl;

        log.info(`${c.success("✓")} API key saved to ${c.dim(configPath)}`);
        log.info(`${c.success("✓")} Relay: ${c.accent(wsRelayUrl)}\n`);

        // Auto-select the PizzaPi dark theme for new installations
        try {
            const piSettingsPath = join(homedir(), ".pizzapi", "settings.json");
            let piSettings: Record<string, unknown> = {};
            try {
                const existing = readFileSync(piSettingsPath, "utf-8");
                piSettings = JSON.parse(existing);
            } catch {}
            if (!piSettings.theme) {
                piSettings.theme = "pizzapi-dark";
                mkdirSync(dirname(piSettingsPath), { recursive: true });
                writeFileSync(piSettingsPath, JSON.stringify(piSettings, null, 2) + "\n", "utf-8");
                log.info("✓ Theme set to pizzapi-dark\n");
            }
        } catch (err) {
            log.warn("Note: Could not set default theme:", err instanceof Error ? err.message : String(err));
        }

        return true;
    } finally {
        try { iface.close(); } catch {}
    }
}
