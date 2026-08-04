/**
 * Model provider login over the relay, so credentials can be added from the
 * web UI (or a phone) instead of a terminal on the runner host.
 *
 * pi's OAuth flows are conversational: they emit an authorization URL, then
 * wait for either their loopback callback or a pasted code/redirect URL. That
 * conversation is driven here — each request returns the *next* thing the flow
 * needs, and the UI answers it with `auth_login_submit`.
 *
 * ponytail: one login in flight per runner. Logins are seconds-long and
 * human-driven; a map keyed by login id buys nothing until two people
 * authenticate the same runner at once.
 */
import type { Socket } from "socket.io-client";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import { registerOllamaCloudProvider } from "../../ollama-cloud-models.js";
import { logInfo } from "../logger.js";

const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** What the UI must render next. Never carries secrets back out. */
type LoginStep =
    | {
        state: "prompt";
        loginId: string;
        prompt: { type: AuthPrompt["type"]; message: string; placeholder?: string; options?: { id: string; label: string }[] };
        authUrl?: string;
        info?: string[];
    }
    | { state: "done"; providerId: string }
    | { state: "error"; message: string }
    /** Status poll only: the flow is still running and nobody needs input. */
    | { state: "waiting" };

interface PendingLogin {
    id: string;
    providerId: string;
    /** Resolves the flow's pending prompt with the user's answer. */
    answer?: (value: string) => void;
    /** Rejects the flow's pending prompt (abort/cancel). */
    fail?: (err: Error) => void;
    /** Resolves the in-flight request with the next step. */
    deliver?: (step: LoginStep) => void;
    authUrl?: string;
    info: string[];
    timer: ReturnType<typeof setTimeout>;
}

let pending: PendingLogin | null = null;

/**
 * Last step per login id, kept briefly after the flow ends.
 *
 * The provider's loopback callback can win while the UI sits on the paste card
 * (browser and runner on the same host, or port 53692 published from the
 * container). Nobody is awaiting a step then, so the outcome is parked here for
 * `auth_login_status` to report — that's what lets the UI finish on its own.
 */
const recentResults = new Map<string, LoginStep>();
const RESULT_TTL_MS = 120_000;

function rememberResult(loginId: string, step: LoginStep): void {
    recentResults.set(loginId, step);
    setTimeout(() => recentResults.delete(loginId), RESULT_TTL_MS).unref?.();
}

/** Arm the next step handoff before doing anything that can produce one. */
function nextStep(login: PendingLogin, timeoutMs: number): Promise<LoginStep> {
    return new Promise((resolve) => {
        const timer = setTimeout(
            () => resolve({ state: "error", message: "Timed out waiting for the provider login flow" }),
            timeoutMs,
        );
        login.deliver = (step) => {
            clearTimeout(timer);
            login.deliver = undefined;
            resolve(step);
        };
    });
}

function settle(login: PendingLogin, step: LoginStep): void {
    clearTimeout(login.timer);
    if (pending?.id === login.id) pending = null;
    rememberResult(login.id, step);
    login.deliver?.(step);
}

function cancel(reason: string): void {
    const login = pending;
    if (!login) return;
    login.fail?.(new Error(reason));
    settle(login, { state: "error", message: reason });
}

/** Minimal slice of ModelRuntime this handler needs — lets tests drive the flow. */
type ProviderAuthShape = { auth?: { oauth?: unknown; apiKey?: { login?: unknown } } };

export interface AuthRuntime {
    getProviders(): readonly (ProviderAuthShape & { id: string; name: string })[];
    getProvider(id: string): ProviderAuthShape | undefined;
    listCredentials(): Promise<readonly { providerId: string }[]>;
    login(providerId: string, type: AuthType, interaction: { prompt: (p: AuthPrompt) => Promise<string>; notify: (e: AuthEvent) => void }): Promise<unknown>;
}

async function createRuntime(agentDir: string): Promise<ModelRuntime> {
    const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
    });
    // Same reason as listConfiguredModels: no extensions load here, so
    // ollama-cloud is an unknown provider without an explicit registration.
    registerOllamaCloudProvider(runtime);
    return runtime;
}

/** Auth types a provider can interactively log in with. */
function loginTypes(provider: ProviderAuthShape | undefined): AuthType[] {
    const types: AuthType[] = [];
    if (provider?.auth?.oauth) types.push("oauth");
    if (provider?.auth?.apiKey?.login) types.push("api_key");
    return types;
}

export function registerProviderAuthHandlers(
    socket: Socket,
    isShuttingDown: () => boolean,
    resolveAgentDir: () => string,
    makeRuntime: (agentDir: string) => Promise<AuthRuntime> = createRuntime,
): void {
    // Settings/packages already answer on `file_result`; it is the daemon's
    // generic request/response ack channel, so no new server listener is needed.
    const reply = (requestId: string | undefined, payload: Record<string, unknown>) =>
        socket.emit("file_result", { requestId, ...payload });

    socket.on("auth_list", async (data: any) => {
        if (isShuttingDown()) return;
        try {
            const runtime = await makeRuntime(resolveAgentDir());
            const configured = new Set((await runtime.listCredentials()).map((cred) => cred.providerId));
            const providers = runtime
                .getProviders()
                .map((provider) => ({
                    id: provider.id,
                    name: provider.name,
                    types: loginTypes(provider),
                    configured: configured.has(provider.id),
                }))
                .filter((provider) => provider.types.length > 0);
            reply(data?.requestId, { ok: true, providers });
        } catch (err) {
            reply(data?.requestId, { ok: false, message: err instanceof Error ? err.message : String(err) });
        }
    });

    socket.on("auth_login_start", async (data: any) => {
        if (isShuttingDown()) return;
        const providerId = typeof data?.providerId === "string" ? data.providerId : "";
        const type: AuthType = data?.authType === "api_key" ? "api_key" : "oauth";
        if (!providerId) {
            reply(data?.requestId, { ok: false, message: "Missing providerId" });
            return;
        }

        cancel("Superseded by a new login");

        try {
            const runtime = await makeRuntime(resolveAgentDir());
            if (!loginTypes(runtime.getProvider(providerId)).includes(type)) {
                reply(data?.requestId, { ok: false, message: `${providerId} does not support ${type} login` });
                return;
            }

            const login: PendingLogin = {
                id: randomUUID(),
                providerId,
                info: [],
                timer: setTimeout(() => cancel("Login expired"), LOGIN_TIMEOUT_MS),
            };
            pending = login;

            const step = nextStep(login, 30_000);

            const notify = (event: AuthEvent) => {
                if (event.type === "auth_url") login.authUrl = event.url;
                else if (event.type === "info") login.info.push(event.message);
            };
            const prompt = (p: AuthPrompt) =>
                new Promise<string>((resolve, reject) => {
                    login.answer = resolve;
                    login.fail = reject;
                    // The flow aborts this prompt if its loopback callback wins.
                    p.signal?.addEventListener("abort", () => reject(new Error("Prompt aborted")), { once: true });
                    login.deliver?.({
                        state: "prompt",
                        loginId: login.id,
                        prompt: {
                            type: p.type,
                            message: p.message,
                            placeholder: p.type === "select" ? undefined : p.placeholder,
                            options: p.type === "select" ? p.options.map((o) => ({ id: o.id, label: o.label })) : undefined,
                        },
                        authUrl: login.authUrl,
                        info: login.info.length ? [...login.info] : undefined,
                    });
                });

            runtime
                .login(providerId, type, { prompt, notify })
                .then(() => {
                    logInfo(`provider auth: ${providerId} credentials saved`);
                    settle(login, { state: "done", providerId });
                })
                .catch((err) => settle(login, { state: "error", message: err instanceof Error ? err.message : String(err) }));

            reply(data?.requestId, { ok: true, step: await step });
        } catch (err) {
            reply(data?.requestId, { ok: false, message: err instanceof Error ? err.message : String(err) });
        }
    });

    socket.on("auth_login_submit", async (data: any) => {
        if (isShuttingDown()) return;
        const login = pending;
        if (!login || login.id !== data?.loginId) {
            reply(data?.requestId, { ok: false, message: "No login in progress — start again" });
            return;
        }
        const answer = login.answer;
        if (!answer) {
            reply(data?.requestId, { ok: false, message: "Login is not waiting for input" });
            return;
        }
        const step = nextStep(login, 60_000);
        login.answer = undefined;
        answer(typeof data?.value === "string" ? data.value : "");
        reply(data?.requestId, { ok: true, step: await step });
    });

    socket.on("auth_login_status", (data: any) => {
        if (isShuttingDown()) return;
        const loginId = data?.loginId;
        const finished = recentResults.get(loginId);
        if (finished) {
            reply(data?.requestId, { ok: true, step: finished });
            return;
        }
        if (pending?.id === loginId) {
            reply(data?.requestId, { ok: true, step: { state: "waiting" } });
            return;
        }
        reply(data?.requestId, { ok: false, message: "No login in progress — start again" });
    });

    socket.on("auth_login_cancel", (data: any) => {
        if (isShuttingDown()) return;
        if (pending && pending.id === data?.loginId) cancel("Cancelled");
        reply(data?.requestId, { ok: true });
    });
}
