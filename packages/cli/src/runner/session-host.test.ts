import { describe, expect, test } from "bun:test";
import { SessionHost } from "./session-host.js";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

/** Minimal call-recording fake of the AgentSession control surface. */
function makeFakeSession(overrides: Partial<Record<string, unknown>> = {}) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const rec = (method: string) => (...args: unknown[]) => {
        calls.push({ method, args });
        return undefined as never;
    };
    const session: Record<string, unknown> = {
        calls,
        prompt: async (...args: unknown[]) => {
            calls.push({ method: "prompt", args });
        },
        getSteeringMessages: () => ["s1", "s2"],
        getFollowUpMessages: () => ["f1"],
        pendingMessageCount: 3,
        abort: async () => {
            calls.push({ method: "abort", args: [] });
        },
        waitForIdle: async () => {
            calls.push({ method: "waitForIdle", args: [] });
        },
        setModel: async (...args: unknown[]) => {
            calls.push({ method: "setModel", args });
        },
        ...overrides,
    };
    return session;
}

/** Fake runtime whose `.session` getter can be swapped to test live reads. */
function makeFakeRuntime(session: Record<string, unknown>) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    let current = session;
    const runtime: Record<string, unknown> = {
        calls,
        get session() {
            return current;
        },
        setSession(next: Record<string, unknown>) {
            current = next;
        },
        cwd: "/work/dir",
        newSession: async (...args: unknown[]) => {
            calls.push({ method: "newSession", args });
            return { cancelled: false };
        },
        switchSession: async (...args: unknown[]) => {
            calls.push({ method: "switchSession", args });
            return { cancelled: false };
        },
        fork: async (...args: unknown[]) => {
            calls.push({ method: "fork", args });
            return { cancelled: false };
        },
        importFromJsonl: async (...args: unknown[]) => {
            calls.push({ method: "importFromJsonl", args });
            return { cancelled: false };
        },
    };
    return runtime;
}

function makeHost(sessionOverrides = {}, replaceFn?: (f: string[]) => void) {
    const session = makeFakeSession(sessionOverrides);
    const runtime = makeFakeRuntime(session);
    const host = new SessionHost(runtime as unknown as AgentSessionRuntime, replaceFn);
    return { host, runtime, session };
}

describe("SessionHost.sendUserMessage", () => {
    test("string content maps to prompt with extension defaults", async () => {
        const { host, session } = makeHost();
        await host.sendUserMessage("hello");
        const call = (session.calls as any[])[0];
        expect(call.method).toBe("prompt");
        expect(call.args[0]).toBe("hello");
        expect(call.args[1]).toEqual({
            expandPromptTemplates: false,
            streamingBehavior: undefined,
            images: undefined,
            source: "extension",
        });
    });

    test("expandPromptTemplates + deliverAs are passed through", async () => {
        const { host, session } = makeHost();
        await host.sendUserMessage("go", { deliverAs: "steer", expandPromptTemplates: true });
        const call = (session.calls as any[])[0];
        expect(call.args[1].expandPromptTemplates).toBe(true);
        expect(call.args[1].streamingBehavior).toBe("steer");
    });

    test("array content joins text with newlines and collects images", async () => {
        const { host, session } = makeHost();
        const img = { type: "image", data: "b64", mimeType: "image/png" };
        await host.sendUserMessage([
            { type: "text", text: "a" },
            img as any,
            { type: "text", text: "b" },
        ]);
        const call = (session.calls as any[])[0];
        expect(call.args[0]).toBe("a\nb");
        expect(call.args[1].images).toEqual([img]);
    });

    test("array content with no images sets images undefined (not empty array)", async () => {
        const { host, session } = makeHost();
        await host.sendUserMessage([{ type: "text", text: "only text" }]);
        const call = (session.calls as any[])[0];
        expect(call.args[1].images).toBeUndefined();
    });
});

describe("SessionHost.getQueuedMessages", () => {
    test("returns a defensive copy of both queues", () => {
        const { host } = makeHost();
        const q = host.getQueuedMessages();
        expect(q).toEqual({ steering: ["s1", "s2"], followUp: ["f1"] });
        // Mutating the result must not affect subsequent reads.
        q.steering.push("mutated");
        expect(host.getQueuedMessages().steering).toEqual(["s1", "s2"]);
    });
});

describe("SessionHost.replaceQueuedMessages", () => {
    test("throws when no bridge is injected (no public native primitive)", () => {
        const { host } = makeHost();
        expect(() => host.replaceQueuedMessages(["x"])).toThrow(/queue bridge/);
    });

    test("delegates to the injected bridge verbatim (no re-expansion)", () => {
        const seen: string[][] = [];
        const { host } = makeHost({}, (f) => seen.push(f));
        host.replaceQueuedMessages(["already {{expanded}}"]);
        expect(seen).toEqual([["already {{expanded}}"]]);
    });
});

describe("SessionHost runtime delegation", () => {
    test("newSession/switchSession/fork/importFromJsonl delegate to runtime", async () => {
        const { host, runtime } = makeHost();
        await host.newSession({ parentSession: "p" });
        await host.switchSession("/path/a", undefined);
        await host.fork("entry1", { position: "before" });
        await host.importFromJsonl("/in.jsonl", "/cwd");
        const methods = (runtime.calls as any[]).map((c) => c.method);
        expect(methods).toEqual(["newSession", "switchSession", "fork", "importFromJsonl"]);
        expect((runtime.calls as any[])[1].args[0]).toBe("/path/a");
        expect((runtime.calls as any[])[2].args).toEqual(["entry1", { position: "before" }]);
    });
});

describe("SessionHost live-session reads", () => {
    test("session controls target the current runtime.session after replacement", async () => {
        const { host, runtime } = makeHost();
        // Swap in a fresh session (simulates /new or /resume replacing runtime.session).
        const next = makeFakeSession({ getSteeringMessages: () => ["NEW"], getFollowUpMessages: () => [] });
        (runtime as any).setSession(next);
        expect(host.getQueuedMessages()).toEqual({ steering: ["NEW"], followUp: [] });
        await host.abort();
        expect((next.calls as any[]).some((c) => c.method === "abort")).toBe(true);
        // Old session must be untouched.
    });
});

describe("SessionHost passthroughs", () => {
    test("cwd, pendingMessageCount, abort, waitForIdle, setModel", async () => {
        const { host, session } = makeHost();
        expect(host.cwd).toBe("/work/dir");
        expect(host.pendingMessageCount).toBe(3);
        await host.abort();
        await host.waitForIdle();
        await host.setModel({ id: "m" } as any);
        const methods = (session.calls as any[]).map((c) => c.method);
        expect(methods).toEqual(["abort", "waitForIdle", "setModel"]);
    });
});
