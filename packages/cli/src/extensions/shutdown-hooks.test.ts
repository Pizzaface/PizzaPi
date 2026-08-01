import { describe, test, expect, beforeEach } from "bun:test";
import {
    registerWorkerShutdownHook,
    registeredShutdownHookIds,
    runWorkerShutdownHooks,
    __resetWorkerShutdownHooksForTest,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    type WorkerShutdownContext,
} from "./shutdown-hooks.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
    __resetWorkerShutdownHooksForTest();
});

describe("registerWorkerShutdownHook", () => {
    test("registers and unregisters by id", () => {
        const off = registerWorkerShutdownHook("a", () => {});
        expect(registeredShutdownHookIds()).toEqual(["a"]);
        off();
        expect(registeredShutdownHookIds()).toEqual([]);
    });

    test("a stale unregister does not drop a later re-registration", () => {
        const off = registerWorkerShutdownHook("a", () => {});
        registerWorkerShutdownHook("a", () => {});
        off(); // closure from the first registration
        expect(registeredShutdownHookIds()).toEqual(["a"]);
    });
});

describe("runWorkerShutdownHooks", () => {
    test("runs every registered hook with the shutdown reason", async () => {
        const seen: string[] = [];
        registerWorkerShutdownHook("a", (ctx) => { seen.push(`a:${ctx.reason}`); });
        registerWorkerShutdownHook("b", (ctx) => { seen.push(`b:${ctx.reason}`); });

        await runWorkerShutdownHooks("close");

        expect(seen.sort()).toEqual(["a:close", "b:close"]);
    });

    test("awaits async hooks before resolving", async () => {
        let flushed = false;
        registerWorkerShutdownHook("slow", async () => {
            await sleep(20);
            flushed = true;
        });

        await runWorkerShutdownHooks("close");

        expect(flushed).toBe(true);
    });

    test("is a no-op when nothing is registered", async () => {
        await runWorkerShutdownHooks("close");
        expect(registeredShutdownHookIds()).toEqual([]);
    });

    test("a throwing hook does not prevent the others from running", async () => {
        const ran: string[] = [];
        registerWorkerShutdownHook("boom", () => { throw new Error("flush failed"); });
        registerWorkerShutdownHook("ok", () => { ran.push("ok"); });

        await runWorkerShutdownHooks("close");

        expect(ran).toEqual(["ok"]);
    });

    test("a rejecting async hook does not prevent the others from running", async () => {
        const ran: string[] = [];
        registerWorkerShutdownHook("boom", async () => { throw new Error("flush failed"); });
        registerWorkerShutdownHook("ok", async () => { ran.push("ok"); });

        await runWorkerShutdownHooks("close");

        expect(ran).toEqual(["ok"]);
    });

    test("concurrent callers share one run rather than racing", async () => {
        let calls = 0;
        registerWorkerShutdownHook("once", async () => {
            calls += 1;
            await sleep(20);
        });

        // The signal handler and the extension shutdownHandler can both fire.
        await Promise.all([runWorkerShutdownHooks("close"), runWorkerShutdownHooks("complete")]);

        expect(calls).toBe(1);
    });

    test("a later caller awaits the in-flight run instead of exiting early", async () => {
        let finished = false;
        registerWorkerShutdownHook("slow", async () => {
            await sleep(30);
            finished = true;
        });

        const first = runWorkerShutdownHooks("close");
        // Second caller must not resolve before the first run completes —
        // otherwise it proceeds to process.exit() mid-flush.
        await runWorkerShutdownHooks("close");
        expect(finished).toBe(true);
        await first;
    });

    test("ONE deadline bounds N hooks, not N x timeout", async () => {
        // Four hooks that each outlast the budget. Sequential-with-per-hook
        // timeouts would take ~4x; the shared window must cap the total.
        for (const id of ["a", "b", "c", "d"]) {
            registerWorkerShutdownHook(id, async () => { await sleep(5_000); });
        }

        const started = Date.now();
        await runWorkerShutdownHooks("close", { timeoutMs: 100 });
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(600);
    });

    test("aborts the shared signal at the deadline so hooks can cancel their own work", async () => {
        let abortedDuringRun = false;
        registerWorkerShutdownHook("watcher", async (ctx) => {
            await new Promise<void>((resolve) => {
                if (ctx.signal.aborted) { abortedDuringRun = true; resolve(); return; }
                ctx.signal.addEventListener("abort", () => { abortedDuringRun = true; resolve(); }, { once: true });
            });
        });

        await runWorkerShutdownHooks("close", { timeoutMs: 50 });

        expect(abortedDuringRun).toBe(true);
    });

    test("passes a shared absolute deadline to every hook", async () => {
        const deadlines: number[] = [];
        registerWorkerShutdownHook("a", (ctx) => { deadlines.push(ctx.deadline); });
        registerWorkerShutdownHook("b", (ctx) => { deadlines.push(ctx.deadline); });

        const before = Date.now();
        await runWorkerShutdownHooks("close", { timeoutMs: 500 });

        expect(deadlines).toHaveLength(2);
        expect(deadlines[0]).toBe(deadlines[1]!);
        expect(deadlines[0]!).toBeGreaterThanOrEqual(before);
        expect(deadlines[0]!).toBeLessThanOrEqual(before + 500 + 50);
    });

    test("forwards session identity to hooks", async () => {
        let received: WorkerShutdownContext | null = null;
        registerWorkerShutdownHook("capture", (ctx) => { received = ctx; });

        await runWorkerShutdownHooks("error", { sessionFile: "/tmp/session.jsonl", cwd: "/tmp/work" });

        expect(received!.reason).toBe("error");
        expect(received!.sessionFile).toBe("/tmp/session.jsonl");
        expect(received!.cwd).toBe("/tmp/work");
    });

    test("default budget stays inside the daemon SIGKILL escalation window", () => {
        expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(2500);
    });
});
