/**
 * `runner pair [--force]` — mint a fresh headless-paired API key on demand.
 *
 * Runs the same device-claim flow `ensureRunnerCredentials()` runs
 * automatically on a credential-less boot (see pairing.ts), but invokable
 * any time an operator wants a fresh key — e.g. after revoking a container's
 * key in the web UI, instead of the old "rm config.json && restart" recipe.
 *
 * Two guard rails, both refuse-by-default (require --force to bypass):
 *  1. An existing credential (env or config) already resolves — don't
 *     clobber it silently.
 *  2. One of the three "wins at runtime" env vars is set — pairing would
 *     write a key to config.json that never takes effect. A prominent
 *     warn-and-proceed (instead of refusing) risks the exact silent
 *     failure this command exists to eliminate: an operator scanning for
 *     "paired successfully" would see it and walk away, never noticing a
 *     warning line above it. Refusing forces a conscious decision.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { c } from "../cli-colors.js";
import { loadGlobalConfig, resolveAgentDir, saveConfigAt } from "../config.js";
import { toHttpRelayUrl } from "../relay-url.js";
import { requestHeadlessPairing } from "../setup.js";
import { defaultStatePath, isPidRunning, type RunnerState } from "./runner-state.js";
import { resolveKnownRelayUrl } from "./pairing.js";

export type CredentialSource = "PIZZAPI_RUNNER_API_KEY" | "PIZZAPI_API_KEY" | "PIZZAPI_API_TOKEN" | "config.json";

/**
 * Pure: mirrors resolveExistingApiKey's priority chain (pairing.ts) but
 * reports *where* a credential came from instead of its value — callers
 * must never print the key itself.
 */
export function resolveCredentialSource(
    env: { PIZZAPI_RUNNER_API_KEY?: string; PIZZAPI_API_KEY?: string; PIZZAPI_API_TOKEN?: string },
    hasConfigApiKey: boolean,
): CredentialSource | undefined {
    if (env.PIZZAPI_RUNNER_API_KEY) return "PIZZAPI_RUNNER_API_KEY";
    if (env.PIZZAPI_API_KEY) return "PIZZAPI_API_KEY";
    if (env.PIZZAPI_API_TOKEN) return "PIZZAPI_API_TOKEN";
    return hasConfigApiKey ? "config.json" : undefined;
}

export interface PairDecision {
    proceed: boolean;
    refusalReason?: string;
    warning?: string;
}

/**
 * Pure decision for both guard rails described above, given where (if
 * anywhere) a credential currently resolves from and whether --force was
 * passed.
 */
export function decidePairAction(existingSource: CredentialSource | undefined, force: boolean): PairDecision {
    const shadowVar = existingSource && existingSource !== "config.json" ? existingSource : undefined;

    if (existingSource && !force) {
        return {
            proceed: false,
            refusalReason: shadowVar
                ? `${shadowVar} is already set and resolves ahead of config.json at runtime — pairing now would mint a key that's silently ignored. Unset ${shadowVar} (remove it from Compose's "environment:") and re-run, or pass --force to pair anyway (still prints this warning and proceeds despite the shadow).`
                : `An API key is already configured (source: config.json). Re-run with --force to replace it.`,
        };
    }

    if (shadowVar) {
        return {
            proceed: true,
            warning: `${shadowVar} is set and takes priority over config.json at runtime — the freshly paired key will be ignored until you unset ${shadowVar}.`,
        };
    }

    return { proceed: true };
}

/** Pure: is a runner daemon actively holding the process lock right now? */
export function isDaemonRunning(state: Partial<Pick<RunnerState, "pid">> | null, isAlive: (pid: number) => boolean): boolean {
    return typeof state?.pid === "number" && state.pid > 0 && isAlive(state.pid);
}

function readState(statePath: string): Partial<RunnerState> | null {
    if (!existsSync(statePath)) return null;
    try {
        return JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {
        return null;
    }
}

export async function runPair(args: string[] = []): Promise<number> {
    const force = args.includes("--force");
    const agentDir = resolveAgentDir();
    const config = loadGlobalConfig();

    const env = {
        PIZZAPI_RUNNER_API_KEY: process.env.PIZZAPI_RUNNER_API_KEY,
        PIZZAPI_API_KEY: process.env.PIZZAPI_API_KEY,
        PIZZAPI_API_TOKEN: process.env.PIZZAPI_API_TOKEN,
    };
    const decision = decidePairAction(resolveCredentialSource(env, Boolean(config.apiKey)), force);

    if (!decision.proceed) {
        console.error(`${c.error("✗ Refusing to pair:")} ${decision.refusalReason}`);
        return 1;
    }
    if (decision.warning) {
        console.error(`${c.warning("⚠")}  ${decision.warning}`);
    }

    // Same resolution as the supervisor's auto-pair path — env, then config,
    // no localhost default (see pairing.ts's own doc comment for why).
    const knownRelayUrl = resolveKnownRelayUrl(config.relayUrl);
    if (!knownRelayUrl) {
        console.error(`${c.error("✗")} No relay URL known. Set PIZZAPI_RELAY_URL and re-run.`);
        return 1;
    }
    const relayUrl = toHttpRelayUrl(knownRelayUrl);

    const label = process.env.PIZZAPI_RUNNER_NAME?.trim() || hostname();
    console.log(`Pairing with ${c.accent(relayUrl)} as "${label}"…`);

    const result = await requestHeadlessPairing(relayUrl, { label });
    if ("error" in result) {
        console.error(`${c.error("✗ Pairing failed:")} ${result.error}`);
        return 1;
    }

    // Replace only the credential fields — never touch unrelated config keys.
    saveConfigAt(agentDir, { apiKey: result.apiKey, relayUrl: result.relayUrl });
    console.log(`${c.success("✓")} Paired. API key saved to ${join(agentDir, "config.json")}.`);

    const state = readState(defaultStatePath());
    if (isDaemonRunning(state, isPidRunning)) {
        console.log(
            `${c.warning("⚠")}  A runner daemon is already running (pid ${state!.pid}) and is still using the old ` +
                `credential in memory. Restart it to pick up the new key: ${c.cmd("pizza runner stop")} then start it ` +
                `again, or ${c.cmd("docker restart <container>")}.`,
        );
    }

    return 0;
}
