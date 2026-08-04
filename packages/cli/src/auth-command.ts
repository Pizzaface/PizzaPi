/**
 * `pizza auth` — model provider login, headless.
 *
 * The only way to authenticate a provider used to be `/login` inside the
 * interactive TUI, which a containerized or SSH-only runner can't reach
 * comfortably. This drives the same pi flows (ModelRuntime.login) from a
 * plain terminal, writing to the same `<agentDir>/auth.json` the daemon's
 * session workers read.
 *
 * In Docker:  docker exec -it <container> pizza auth anthropic
 * The OAuth flows accept a pasted redirect URL, so the browser can live on a
 * different machine than the runner — no callback port needs publishing.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import { createInterface } from "readline";
import { join } from "path";
import { c } from "./cli-colors.js";
import { defaultAgentDir, expandHome, loadConfig } from "./config.js";
import { registerOllamaCloudProvider } from "./ollama-cloud-models.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("auth");

const NO_STDIN =
    "No interactive input: stdin is closed. Attach a terminal, e.g. `docker exec -it <container> pizza auth <provider>`.";

/**
 * Read one line. `signal` matters: OAuth flows race a "paste the code" prompt
 * against their loopback callback server and abort the prompt when the
 * callback wins — without this the CLI would hang after a successful browser
 * login.
 *
 * The EOF path matters just as much: with stdin closed (plain `docker exec`,
 * a detached service), readline's callback never fires and the process used
 * to exit silently mid-prompt, dropping the typed line into the parent shell.
 */
function ask(message: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Prompt aborted"));
            return;
        }
        const iface = createInterface({ input: process.stdin, output: process.stdout });
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            iface.close();
            fn();
        };
        const onAbort = () => finish(() => reject(new Error("Prompt aborted")));
        signal?.addEventListener("abort", onAbort, { once: true });
        iface.on("close", () => finish(() => reject(new Error(NO_STDIN))));
        process.stdin.on("error", (err) => finish(() => reject(err)));
        iface.question(message, (answer) => finish(() => resolve(answer.trim())));
    });
}

/** Line-based prompt with echo off, for API keys. */
function askSecret(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
        process.stdout.write(message);
        const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
        const iface = createInterface({ input: stdin, terminal: false });
        stdin.setRawMode?.(true);
        stdin.once("end", () => {
            stdin.setRawMode?.(false);
            reject(new Error(NO_STDIN));
        });
        let value = "";
        stdin.on("data", function onData(chunk: Buffer) {
            for (const char of chunk.toString()) {
                if (char === "\r" || char === "\n") {
                    stdin.removeListener("data", onData);
                    stdin.setRawMode?.(false);
                    process.stdout.write("\n");
                    iface.close();
                    resolve(value.trim());
                    return;
                }
                if (char === "\u0003") {
                    stdin.setRawMode?.(false);
                    process.exit(130);
                }
                if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
                else value += char;
            }
        });
    });
}

function notify(event: AuthEvent): void {
    if (event.type === "auth_url") {
        log.info("");
        log.info(c.dim(event.instructions ?? "Open this URL to authorize:"));
        log.info(c.accent(event.url));
        log.info("");
    } else if (event.type === "device_code") {
        log.info(`Code ${c.accent(event.userCode)} — enter it at ${c.accent(event.verificationUri)}`);
    } else if (event.type === "info") {
        log.info(event.message);
        for (const link of event.links ?? []) log.info(`  ${link.label ?? ""} ${c.accent(link.url)}`.trim());
    } else {
        log.info(c.dim(event.message));
    }
}

/** Empty answer = the first option; otherwise a 1-based index. */
export function pickOption<T extends { id: string }>(options: readonly T[], answer: string): T {
    const chosen = options[answer ? Number(answer) - 1 : 0];
    if (!chosen) throw new Error(`Invalid choice: ${answer}`);
    return chosen;
}

async function prompt(p: AuthPrompt): Promise<string> {
    if (p.type === "select") {
        log.info(p.message);
        p.options.forEach((opt, i) => log.info(`  ${i + 1}) ${opt.label}${opt.description ? c.dim(` — ${opt.description}`) : ""}`));
        return pickOption(p.options, await ask("Choice [1]: ", p.signal)).id;
    }
    if (p.type === "secret") return askSecret(`${p.message} `);
    return ask(`${p.message} `, p.signal);
}

/** Auth types a provider can actually log in with (ambient-only api key has no `login`). */
export function loginTypes(provider: { auth?: { oauth?: unknown; apiKey?: { login?: unknown } } } | undefined): AuthType[] {
    const types: AuthType[] = [];
    if (provider?.auth?.oauth) types.push("oauth");
    if (provider?.auth?.apiKey?.login) types.push("api_key");
    return types;
}

export async function runAuthCommand(args: string[], cwd: string): Promise<number> {
    const config = loadConfig(cwd);
    const agentDir = config.agentDir ? expandHome(config.agentDir) : defaultAgentDir();
    const authPath = join(agentDir, "auth.json");

    if (!process.stdin.isTTY && args.some((a) => !a.startsWith("-"))) {
        log.warn("stdin is not a terminal — login prompts need one. Re-run with `docker exec -it …` / an interactive shell.");
    }

    const runtime = await ModelRuntime.create({ authPath, modelsPath: join(agentDir, "models.json") });
    registerOllamaCloudProvider(runtime);

    const providerId = args.find((a) => !a.startsWith("-"));

    if (!providerId) {
        const configured = new Set((await runtime.listCredentials()).map((cred) => cred.providerId));
        log.info("");
        log.info(c.label("Providers"));
        for (const provider of runtime.getProviders()) {
            const types = loginTypes(provider);
            if (types.length === 0) continue;
            const mark = configured.has(provider.id) ? c.success("✓") : c.dim("·");
            log.info(`  ${mark} ${provider.id.padEnd(18)} ${c.dim(types.join(", "))}`);
        }
        log.info("");
        log.info(c.dim(`Credentials: ${authPath}`));
        log.info(c.dim("Log in with: ") + c.cmd("pizza auth <provider>"));
        log.info("");
        return 0;
    }

    const provider = runtime.getProvider(providerId);
    if (!provider) {
        log.error(`Unknown provider "${providerId}". Run ${c.cmd("pizza auth")} to list providers.`);
        return 1;
    }

    const types = loginTypes(provider);
    if (types.length === 0) {
        log.error(`${providerId} has no interactive login (it reads ambient credentials, e.g. an env var).`);
        return 1;
    }

    try {
        let type = types[0]!;
        if (types.length > 1) {
            type = (await prompt({
                type: "select",
                message: `How do you want to authenticate with ${provider.name}?`,
                options: [
                    { id: "oauth", label: "Sign in (OAuth / subscription)" },
                    { id: "api_key", label: "Paste an API key" },
                ],
            })) as AuthType;
        }
        await runtime.login(providerId, type, { prompt, notify });
    } catch (err) {
        log.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }

    log.info(`${c.success("✓")} ${provider.name} credentials saved to ${c.dim(authPath)}`);
    log.info(c.dim("New sessions pick this up automatically; running sessions keep their old credential."));
    return 0;
}
