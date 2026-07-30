/**
 * Integration coverage for the SessionHost publication boundary shared by the
 * runner worker (worker.ts) and the interactive CLI (index.ts).
 *
 * Regression covered (PR #635 review): removing the patched ExtensionAPI
 * control surface left `getRemoteSessionHost()` (session-host-ref.ts) as the
 * only way remote handlers reach session control, and two ordering bugs
 * surfaced:
 *
 *  1. relay-context-factory.ts snapshotted the host at extension-factory-load
 *     time. The worker loads extension factories during `loader.reload()`
 *     (worker.ts ~line 390) — well before it constructs and publishes its
 *     SessionHost via `setRemoteSessionHost()` (worker.ts ~line 695) — so the
 *     snapshot froze `RelayContext.sessionHost` at null until reload.
 *  2. The interactive CLI built an `AgentSessionRuntime` but never called
 *     `setRemoteSessionHost(runtimeSessionHost(runtime))`, so TUI relay
 *     commands (new/switch/fork/queue-edit) had no host to drive at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { createRelayContext } from "./relay-context-factory.js";
import { createTriggerWaitManager } from "../trigger-wait-manager.js";
import { getRemoteSessionHost, setRemoteSessionHost } from "./session-host-ref.js";
import { runtimeSessionHost } from "../../runner/session-host.js";

afterEach(() => {
    // session-host-ref holds a process-wide singleton — reset it so these
    // tests don't leak state into other test files sharing the test process.
    setRemoteSessionHost(null);
});

function makeFakeSession() {
    const queueCalls: string[] = [];
    return {
        queueCalls,
        pendingMessageCount: 0,
        getSteeringMessages: () => [] as string[],
        getFollowUpMessages: () => [] as string[],
        clearQueue: () => ({ steering: [] as string[] }),
        _queueSteer: (text: string) => queueCalls.push(`steer:${text}`),
        _queueFollowUp: (text: string) => queueCalls.push(`followUp:${text}`),
        abort: async () => {},
        waitForIdle: async () => {},
        setModel: async () => {},
        prompt: async () => {},
    };
}

describe("worker startup boundary: extension factory load vs host publication", () => {
    test("a RelayContext created before the worker publishes its host still resolves the live host afterward", () => {
        expect(getRemoteSessionHost()).toBeNull();

        // Mirrors worker.ts: the remote extension factory (and the
        // RelayContext it builds) loads during loader.reload(), before the
        // worker constructs its SessionHost and calls setRemoteSessionHost().
        const rctx = createRelayContext({}, createTriggerWaitManager(), { lastBroadcastSessionName: null });
        expect(rctx.sessionHost).toBeNull();

        const session = makeFakeSession();
        const host = runtimeSessionHost({
            get session() {
                return session;
            },
            newSession: async () => ({ cancelled: false }),
            switchSession: async () => ({ cancelled: false }),
            fork: async () => ({ cancelled: false }),
        } as unknown as AgentSessionRuntime);

        // Published after the context already exists — a one-time snapshot
        // taken at construction would freeze rctx.sessionHost at null for
        // the process lifetime.
        setRemoteSessionHost(host);

        expect(rctx.sessionHost).toBe(host);
    });
});

describe("interactive CLI (TUI) host wiring", () => {
    test("setRemoteSessionHost(runtimeSessionHost(runtime)) lets remote handlers drive new/switch/fork/queue-edit through the runtime", async () => {
        let currentSession = makeFakeSession();
        const calls: string[] = [];
        const runtime = {
            get session() {
                return currentSession;
            },
            newSession: async () => {
                calls.push("newSession");
                currentSession = makeFakeSession();
                return { cancelled: false };
            },
            switchSession: async (p: string) => {
                calls.push(`switchSession:${p}`);
                currentSession = makeFakeSession();
                return { cancelled: false };
            },
            fork: async (id: string) => {
                calls.push(`fork:${id}`);
                return { cancelled: false };
            },
        } as unknown as AgentSessionRuntime;

        // Mirrors the index.ts fix: install the TUI-backed host, with the
        // same raw-requeue bridge shape worker.ts uses, before any remote
        // command can run.
        setRemoteSessionHost(
            runtimeSessionHost(runtime, (followUp) => {
                const { steering } = currentSession.clearQueue();
                for (const text of steering) currentSession._queueSteer(text);
                for (const text of followUp) currentSession._queueFollowUp(text);
            }),
        );

        const rctx = createRelayContext({}, createTriggerWaitManager(), { lastBroadcastSessionName: null });
        expect(rctx.sessionHost).not.toBeNull();

        await rctx.sessionHost!.newSession();
        await rctx.sessionHost!.switchSession("/tmp/foo.jsonl");
        await rctx.sessionHost!.fork("entry-1");
        // Queue bridge must resolve against the *current* session after
        // fork() replaced it, not a stale reference captured at host
        // construction — this is exactly what regresses without the fix.
        rctx.sessionHost!.replaceQueuedMessages(["queued follow-up"]);

        expect(calls).toEqual(["newSession", "switchSession:/tmp/foo.jsonl", "fork:entry-1"]);
        expect(currentSession.queueCalls).toEqual(["followUp:queued follow-up"]);
    });

    test("without wiring, sessionHost stays null and remote handlers no-op/guard instead of crashing", () => {
        // No setRemoteSessionHost() call — reproduces the pre-fix state of
        // index.ts (remoteExtension installed, host never published).
        const rctx = createRelayContext({}, createTriggerWaitManager(), { lastBroadcastSessionName: null });
        expect(rctx.sessionHost).toBeNull();
    });
});
