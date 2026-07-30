import { spawn } from "node:child_process";
import { createWriteStream, openSync, readSync, closeSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";

/**
 * Bash override with auto-backgrounding.
 *
 * Reuses pi's built-in bash tool (schema, streaming, truncation, renderers)
 * via createBashToolDefinition and swaps only the exec layer. Behavior:
 *
 * - Every call takes a `title` (its purpose), used in status/completion messages.
 * - Output streams normally for the first N seconds (default 15, configurable via
 *   `bash.backgroundAfterSeconds` or PIZZAPI_BASH_BACKGROUND_SECONDS).
 * - Past that the call returns: output keeps flowing to a tmp log file and the
 *   model is told the command is still running (and told not to sleep/poll).
 * - `run_in_background: true` backgrounds immediately (threshold 0).
 * - Manual backgrounding of ANY running bash call: TUI ctrl+shift+b,
 *   /background, or the web UI's `background_bash` exec command.
 * - On exit — any code — a completion message is delivered into the session.
 *
 * Plan-mode command blocking still applies: it hooks `tool_call` by tool name,
 * and this override keeps the name "bash".
 */

const TAIL_BYTES = 4000;
const DEFAULT_BACKGROUND_AFTER_SECONDS = 15;
const DELIVERY_RETRY_MS = 10_000;
const MAX_DELIVERY_ATTEMPTS = 3;

/** Seconds a bash call streams in the foreground before it auto-backgrounds. 0 = immediate. */
export function backgroundAfterSeconds(): number {
    const raw = process.env.PIZZAPI_BASH_BACKGROUND_SECONDS ?? readConfiguredSeconds();
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : DEFAULT_BACKGROUND_AFTER_SECONDS;
}

// ponytail: config read once per process (bash runs often); restart to change it.
let configuredSeconds: number | undefined | null = null;
function readConfiguredSeconds(): number | undefined {
    if (configuredSeconds === null) {
        try {
            configuredSeconds = loadConfig(process.cwd())?.bash?.backgroundAfterSeconds;
        } catch {
            configuredSeconds = undefined;
        }
    }
    return configuredSeconds;
}

/** Running foreground bash calls, keyed by pid. Calling the value backgrounds the job now. */
const waiting = new Map<number, { command: string; backgroundNow: () => void }>();

interface BackgroundJob {
    pid: number;
    command: string;
    title: string;
    logPath: string;
    startedAt: number;
    /** Set once the process exits. null = killed by signal. */
    exitCode?: number | null;
    signal?: string | null;
    endedAt?: number;
    /** Byte offset of the last bash_output read — next read returns only new output. */
    readOffset: number;
}

/** Backgrounded jobs (running or exited), keyed by pid. Kept for bash_output/kill_shell. */
// ponytail: unbounded per-session map of tiny records (output lives on disk) — prune if sessions ever run thousands of background jobs.
const jobs = new Map<number, BackgroundJob>();

/** Read a file from `offset` to EOF. */
function readFrom(path: string, offset: number): { text: string; newOffset: number } {
    let fd: number | undefined;
    try {
        const size = statSync(path).size;
        if (size <= offset) return { text: "", newOffset: offset };
        const len = size - offset;
        const buf = Buffer.allocUnsafe(len);
        fd = openSync(path, "r");
        readSync(fd, buf, 0, len, offset);
        return { text: buf.toString("utf8"), newOffset: size };
    } catch {
        return { text: "", newOffset: offset };
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function jobStatus(job: BackgroundJob): string {
    if (job.endedAt === undefined) return "running";
    if (job.signal) return `killed by ${job.signal}`;
    return `exited ${job.exitCode}`;
}

function listJobsText(): string {
    if (jobs.size === 0) return "No background shells.";
    return [...jobs.values()]
        .map((j) => `pid ${j.pid} [${jobStatus(j)}] ${j.title} — ${j.command} (log: ${j.logPath})`)
        .join("\n");
}

/** Commands currently running in the foreground (i.e. backgroundable right now). */
export function pendingCommands(): string[] {
    return [...waiting.values()].map((j) => j.command);
}

/**
 * Send every running foreground bash call to the background.
 * Called by the TUI shortcut and the web UI's `background_bash` exec command.
 * Returns the commands that were backgrounded.
 */
export function backgroundPendingJobs(): string[] {
    const commands = pendingCommands();
    for (const job of [...waiting.values()]) job.backgroundNow();
    return commands;
}

/** Last `maxBytes` of a file, as text. */
export function tailFile(path: string, maxBytes = TAIL_BYTES): string {
    let fd: number | undefined;
    try {
        const size = statSync(path).size;
        const start = Math.max(0, size - maxBytes);
        const len = size - start;
        if (len === 0) return "";
        const buf = Buffer.allocUnsafe(len);
        fd = openSync(path, "r");
        readSync(fd, buf, 0, len, start);
        return (start > 0 ? `…(truncated, full log at ${path})\n` : "") + buf.toString("utf8");
    } catch {
        return "";
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

export function formatCompletion(
    title: string,
    code: number | null,
    signalName: string | null,
    ms: number,
    logPath: string,
): string {
    const status = signalName ? `was killed by ${signalName}` : `exited with code ${code}`;
    return `${title} ${status} after ${Math.round(ms / 1000)}s\n\nSee full stdout/stderr in ${logPath}`;
}

function killTree(pid: number): void {
    try {
        // Detached on POSIX → child is its own group leader; kill the group.
        process.platform === "win32" ? process.kill(pid) : process.kill(-pid);
    } catch {
        try { process.kill(pid); } catch { /* already gone */ }
    }
}

// title / run_in_background handoff from the execute wrapper to ops.exec. Safe
// without keying: the path from setting these to consuming them is fully
// synchronous (no await between wrapper entry and ops.exec's first statement).
let nextRunInBackground = false;
let nextTitle = "";

export const backgroundBashExtension: ExtensionFactory = (pi) => {
    // Exit notifications that were sent but haven't shown up in the transcript.
    // Two ways a completion silently vanishes and leaves the session waiting
    // forever: queued microseconds after the agent loop drained its queues, or
    // sendMessage (fire-and-forget) throwing while the agent is
    // between runs. Both are invisible to us, so re-send until a message_start
    // proves it landed.
    const undelivered = new Map<string, { message: any; attempts: number }>();
    let streaming = false;
    let sweeper: ReturnType<typeof setInterval> | undefined;

    const send = (deliveryId: string, entry: { message: any; attempts: number }) => {
        entry.attempts += 1;
        undelivered.set(deliveryId, entry);
        if (!sweeper) {
            sweeper = setInterval(sweep, DELIVERY_RETRY_MS);
            sweeper.unref?.();
        }
        // Steer while streaming so a long turn hears about the exit now instead of
        // at the end of it; when idle the message has to start a turn itself.
        pi.sendMessage(entry.message, (streaming ? { deliverAs: "steer" } : { triggerTurn: true }) as any);
    };

    function sweep(): void {
        if (streaming) return;
        for (const [deliveryId, entry] of undelivered) {
            // ponytail: give up after MAX_DELIVERY_ATTEMPTS rather than risk a resend loop.
            if (entry.attempts >= MAX_DELIVERY_ATTEMPTS) undelivered.delete(deliveryId);
            else send(deliveryId, entry);
        }
        if (undelivered.size === 0 && sweeper) {
            clearInterval(sweeper);
            sweeper = undefined;
        }
    }

    pi.on("agent_start" as any, () => { streaming = true; });
    pi.on("agent_settled" as any, () => { streaming = false; sweep(); });
    pi.on("message_start" as any, (event: any) => {
        const deliveryId = event?.message?.details?.deliveryId;
        if (deliveryId) undelivered.delete(deliveryId);
    });

    const notifyExit = (title: string, command: string, code: number | null, sig: string | null, ms: number, logPath: string, pid: number | undefined) => {
        const deliveryId = `bg-${pid}-${Date.now()}`;
        send(deliveryId, {
            attempts: 0,
            message: {
                customType: "background-bash",
                content: formatCompletion(title, code, sig, ms, logPath),
                display: true,
                details: { title, command, pid, exitCode: code, signal: sig, logPath, deliveryId },
            },
        });
    };

    const exec = async (
        command: string,
        cwd: string,
        { onData, signal, timeout, env }: {
            onData: (data: Buffer) => void;
            signal?: AbortSignal;
            timeout?: number;
            env?: NodeJS.ProcessEnv;
        },
    ): Promise<{ exitCode: number | null }> => {
        const runInBackground = nextRunInBackground;
        const title = nextTitle || command;
        nextRunInBackground = false;
        nextTitle = "";
        if (signal?.aborted) throw new Error("aborted");

        const logPath = join(tmpdir(), `pizzapi-bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
        const log = createWriteStream(logPath);
        const startedAt = Date.now();
        // ponytail: shell:true instead of pi's getShellConfig — loses custom
        // shellPath/windows stdin transport; wire pi's shell utils if that bites.
        const child = spawn(command, {
            shell: true,
            cwd,
            env,
            detached: process.platform !== "win32",
            windowsHide: true,
        });
        const pid = child.pid ?? -1;

        let backgrounded = false;
        const tee = (data: Buffer) => {
            log.write(data);
            if (!backgrounded) onData(data);
        };
        child.stdout?.on("data", tee);
        child.stderr?.on("data", tee);

        const exited = new Promise<{ code: number | null; sig: string | null }>((resolve) => {
            child.on("close", (code, sig) => resolve({ code, sig }));
            child.on("error", (err) => {
                log.write(`spawn error: ${err.message}\n`);
                resolve({ code: 127, sig: null });
            });
        }).then(async (r) => {
            waiting.delete(pid);
            const job = jobs.get(pid);
            if (job) {
                job.exitCode = r.code;
                job.signal = r.sig;
                job.endedAt = Date.now();
            }
            await new Promise<void>((res) => log.end(res));
            return r;
        });

        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let bgTimer: ReturnType<typeof setTimeout> | undefined;
        if (timeout !== undefined && Number.isFinite(timeout) && timeout > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                killTree(pid);
            }, timeout * 1000);
        }
        const onAbort = () => {
            if (!backgrounded) killTree(pid);
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
            const bg = new Promise<"bg">((resolve) => {
                if (runInBackground) return resolve("bg");
                waiting.set(pid, { command, backgroundNow: () => resolve("bg") });
                // Auto-background once the foreground streaming window elapses.
                const after = backgroundAfterSeconds();
                bgTimer = setTimeout(() => resolve("bg"), after * 1000);
                bgTimer.unref?.();
            });

            const raced = await Promise.race([exited, bg]);

            if (raced !== "bg") {
                // Foreground completion — built-in semantics.
                if (signal?.aborted) throw new Error("aborted");
                if (timedOut) throw new Error(`timeout:${timeout}`);
                try { unlinkSync(logPath); } catch { /* best effort */ }
                return { exitCode: raced.code };
            }

            // Backgrounded: stop streaming, let it run, notify on exit.
            backgrounded = true;
            waiting.delete(pid);
            jobs.set(pid, { pid, command, title, logPath, startedAt, readOffset: 0 });
            onData(Buffer.from(
                `\n[Still running: "${title}" (pid ${pid}). Output now goes to ${logPath}. ` +
                `A message will arrive in this session when it exits — do NOT use sleep or poll for it. ` +
                `Continue with other work; use bash_output(${pid}) for new output so far, kill_shell(${pid}) to stop it.]\n`,
            ));
            void exited.then(({ code, sig }) => {
                if (timer) clearTimeout(timer);
                notifyExit(title, command, code, sig, Date.now() - startedAt, logPath, child.pid);
            });
            return { exitCode: 0 };
        } finally {
            if (bgTimer) clearTimeout(bgTimer);
            if (!backgrounded && timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        }
    };

    // ponytail: cwd captured at registration — worker/TUI processes start in the
    // session cwd, so this matches the built-in tool's behavior.
    const def = createBashToolDefinition(process.cwd(), { operations: { exec } });

    pi.registerTool({
        ...def,
        description:
            `${def.description} ` +
            `Output streams back for the first ${backgroundAfterSeconds()}s; if the command is still running after that ` +
            "it keeps running in the background, its output goes to a log file, and a message with the exit code " +
            "is delivered to this session when it finishes. NEVER use `sleep` to wait for it — do other work and the " +
            "message will arrive on its own. Set run_in_background: true to skip the wait entirely (servers, watchers).",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "Bash command to execute" },
                title: {
                    type: "string",
                    description: "Short description of what this command is for (e.g. 'Run server tests'). Shown while it runs and in the completion message.",
                },
                timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
                run_in_background: {
                    type: "boolean",
                    description: "Skip the foreground wait: return immediately and deliver a completion message when the command exits.",
                },
            },
            required: ["command", "title"],
        } as any,
        async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
            nextRunInBackground = params?.run_in_background === true;
            nextTitle = typeof params?.title === "string" ? params.title.trim() : "";
            return def.execute(toolCallId, params, signal, onUpdate, ctx);
        },
    } as any);

    // ── bash_output — incremental output from a background shell ─────────────
    pi.registerTool({
        name: "bash_output",
        label: "Bash Output",
        description:
            "Get new output from a background shell since the last bash_output call (incremental — already-seen output is not repeated). Call without pid to list all background shells and their status. Use this to check progress instead of re-reading the log file.",
        parameters: {
            type: "object",
            properties: {
                pid: { type: "number", description: "Pid of the background shell (from the bash result). Omit to list all background shells." },
            },
        } as any,
        async execute(_toolCallId: string, params: any) {
            const pid = params?.pid;
            if (pid === undefined || pid === null) {
                return { content: [{ type: "text" as const, text: listJobsText() }], details: undefined };
            }
            const job = jobs.get(pid);
            if (!job) {
                return {
                    content: [{ type: "text" as const, text: `No background shell with pid ${pid}.\n${listJobsText()}` }],
                    details: undefined,
                };
            }
            const { text, newOffset } = readFrom(job.logPath, job.readOffset);
            job.readOffset = newOffset;
            const runtime = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
            const header = `[pid ${job.pid}, ${jobStatus(job)}, ${runtime}s] ${job.command}`;
            return {
                content: [{ type: "text" as const, text: `${header}\n${text || "(no new output)"}` }],
                details: { pid: job.pid, status: jobStatus(job), exitCode: job.exitCode },
            };
        },
    } as any);

    // ── kill_shell — kill a background shell's whole process group ───────────
    pi.registerTool({
        name: "kill_shell",
        label: "Kill Shell",
        description:
            "Kill a background shell and its entire process group (children included — plain `kill <pid>` leaves orphans). The completion notification for the shell will report it as killed.",
        parameters: {
            type: "object",
            properties: {
                pid: { type: "number", description: "Pid of the background shell to kill" },
            },
            required: ["pid"],
        } as any,
        async execute(_toolCallId: string, params: any) {
            const job = jobs.get(params?.pid);
            if (!job) {
                return {
                    content: [{ type: "text" as const, text: `No background shell with pid ${params?.pid}.\n${listJobsText()}` }],
                    details: undefined,
                };
            }
            if (job.endedAt !== undefined) {
                return {
                    content: [{ type: "text" as const, text: `pid ${job.pid} already ${jobStatus(job)}: ${job.command}` }],
                    details: undefined,
                };
            }
            killTree(job.pid);
            return {
                content: [{ type: "text" as const, text: `Killed pid ${job.pid}: ${job.command}` }],
                details: undefined,
            };
        },
    } as any);

    const backgroundNow = (ui?: { notify?: (msg: string, level?: string) => void }) => {
        const backgrounded = backgroundPendingJobs();
        const msg = backgrounded.length
            ? `Backgrounded: ${backgrounded.join(", ")}`
            : "Nothing to background (no bash command is running)";
        ui?.notify?.(msg, backgrounded.length ? "info" : "warning");
        return backgrounded;
    };

    // ponytail: ctrl+b is taken by cursorLeft; ctrl+shift+b is free.
    pi.registerShortcut("ctrl+shift+b", {
        description: "Send the running bash command to the background",
        handler: async (ctx: any) => { backgroundNow(ctx?.ui); },
    });

    pi.registerCommand("background", {
        description: "Send the running bash command to the background",
        handler: async (_args: string, ctx: any) => { backgroundNow(ctx?.ui); },
    });
};
