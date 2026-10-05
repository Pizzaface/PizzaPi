/**
 * Environment scrubbing for model-controlled subprocesses (the `bash` tool).
 *
 * Workers inherit nearly all of the runner daemon's environment, plus a
 * PizzaPi relay API key injected by the session spawner. The in-process
 * runtime needs those credentials; shell commands the model writes do not.
 * This module removes **PizzaPi relay/runner/server credentials** from the
 * environment handed to such commands.
 *
 * Boundary: only PizzaPi's own credentials are stripped. Provider keys
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, …), GITHUB_TOKEN/GH_TOKEN, cloud
 * credentials and other user-owned variables are deliberately kept: users
 * export them so the tools they run in their shell (gh, aws, npm, test
 * suites) keep working, and stripping them would break legitimate workflows
 * without being a PizzaPi-specific exposure. PizzaPi stores provider
 * credentials in auth.json rather than injecting them into the environment.
 *
 * Non-secret PizzaPi variables (e.g. PIZZAPI_SESSION_PROC_FILE, which the
 * bash command prefix itself relies on) are preserved.
 */

/** Exact names of PizzaPi credentials and relay-server secrets to strip. */
const STRIPPED_ENV_NAMES: ReadonlySet<string> = new Set([
    // Relay/runner credentials
    "PIZZAPI_API_KEY",
    "PIZZAPI_API_TOKEN",
    "PIZZAPI_RUNNER_API_KEY",
    "PIZZAPI_RUNNER_TOKEN",
    "PIZZAPI_AUTH_TOKEN",
    // Relay-server secrets (present when a runner shares the server's env)
    "BETTER_AUTH_SECRET",
    "VAPID_PRIVATE_KEY",
    "PIZZAPI_TUNNEL_TOKEN_SECRET",
    "PIZZAPI_TUNNEL_TOKEN_SECRET_PREVIOUS",
    "PIZZAPI_NTFY_PUBLISH_TOKEN",
    "PIZZAPI_CADDY_DNS_TOKEN",
    "PIZZAPI_WEBHOOK_SECRET",
]);

/**
 * Any PIZZAPI_-prefixed variable whose name ends like a credential is treated
 * as a PizzaPi credential, so new secrets are covered without updating the
 * list above. Matches e.g. PIZZAPI_FOO_TOKEN and PIZZAPI_BAR_SECRET, but not
 * PIZZAPI_API_KEY_RATE_LIMIT_ENABLED.
 */
const PIZZAPI_CREDENTIAL_PATTERN = /^PIZZAPI_[A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_SECRET_PREVIOUS|_PASSWORD)$/;

/**
 * Comma-separated names the operator explicitly allows through to shell
 * commands anyway (compatibility escape hatch, read from the worker's own
 * environment so the model cannot set it for itself).
 */
export const BASH_PASSTHROUGH_ENV = "PIZZAPI_BASH_PASSTHROUGH_ENV";

function isCredentialName(upper: string): boolean {
    return STRIPPED_ENV_NAMES.has(upper) || PIZZAPI_CREDENTIAL_PATTERN.test(upper);
}

/**
 * True when `name` is a PizzaPi credential that shell commands must not see,
 * or a Docker/K8s-style `<NAME>_FILE` pointer to one (e.g.
 * PIZZAPI_API_KEY_FILE): the CLI expands those into `<NAME>` at startup, and
 * leaving the pointer would let `cat "$PIZZAPI_API_KEY_FILE"` recover the
 * credential the scrubber just removed.
 */
export function isStrippedSubprocessEnvName(name: string): boolean {
    const upper = name.toUpperCase();
    if (isCredentialName(upper)) return true;
    return upper.endsWith("_FILE") && isCredentialName(upper.slice(0, -"_FILE".length));
}

/**
 * Return a copy of `env` without PizzaPi credentials, for model-controlled
 * shell commands. `passthroughSource` supplies the operator's
 * {@link BASH_PASSTHROUGH_ENV} allowlist (defaults to `process.env`).
 */
export function scrubSubprocessEnv(
    env: NodeJS.ProcessEnv,
    passthroughSource: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const passthrough = new Set(
        (passthroughSource[BASH_PASSTHROUGH_ENV] ?? "")
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
    );
    const out: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (isStrippedSubprocessEnvName(key) && !passthrough.has(key.toUpperCase())) continue;
        out[key] = value;
    }
    return out;
}
