import { describe, expect, test } from "bun:test";
import { runtimeSessionHost, SessionHost, type SessionLifecycle } from "./session-host.js";
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

type Call = { method: string; args: unknown[] };

/** Minimal call-recording fake of the AgentSession control surface. */
function makeFakeSession(overrides: Record<string, unknown> = {}) {
    const calls: Call[] = [];
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

/** Call-recording lifecycle stub. */
function makeLifecycle(withImport = true) {
    const calls: Call[] = [];
    const lifecycle: SessionLifecycle & { calls: Call[] } = {
        calls,
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
        ...(withImport
            ? {
                  importFromJsonl: async (...args: unknown[]) => {
                      calls.push({ method: "importFromJsonl", args });
                      return { cancelled: false };
                  },
              }
            : {}),
    };
    return lifecycle;
}

function makeHost(opts: { sessionOverrides?: Record<string, unknown>; replaceFn?: (f: string[]) => void; withImport?: boolean } = {}) {
    let current = makeFakeSession(opts.sessionOverrides);
    const lifecycle = makeLifecycle(opts.withImport ?? true);
    const host = new SessionHost(() => current as unknown as AgentSession, lifecycle, opts.replaceFn);
    return { host, lifecycle, session: () => current, setSession: (s: Record<string, unknown>) => (current = s) };
}

describe("SessionHost.sendUserMessage", () => {
    test("string content maps to prompt with extension defaults", async () => {
        const { host, session } = makeHost();
        await host.sendUserMessage("hello");
        const call = (session().calls as Call[])[0];
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
        const call = (session().calls as Call[])[0];
        expect((call.args[1] as any).expandPromptTemplates).toBe(true);
        expect((call.args[1] as any).streamingBehavior).toBe("steer");
    });

    test("array content joins text with newlines and collects images", async () => {
        const { host, session } = makeHost();
        const img = { type: "image", data: "b64", mimeType: "image/png" };
        await host.sendUserMessage([{ type: "text", text: "a" }, img as any, { type: "text", text: "b" }]);
        const call = (session().calls as Call[])[0];
        expect(call.args[0]).toBe("a\nb");
        expect((call.args[1] as any).images).toEqual([img]);
    });

    test("array content with no images sets images undefined (not empty array)", async () => {
        const { host, session } = makeHost();
        await host.sendUserMessage([{ type: "text", text: "only text" }]);
        const call = (session().calls as Call[])[0];
        expect((call.args[1] as any).images).toBeUndefined();
    });
});

describe("SessionHost.getQueuedMessages", () => {
    test("returns a defensive copy of both queues", () => {
        const { host } = makeHost();
        const q = host.getQueuedMessages();
        expect(q).toEqual({ steering: ["s1", "s2"], followUp: ["f1"] });
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
        const { host } = makeHost({ replaceFn: (f) => seen.push(f) });
        host.replaceQueuedMessages(["already {{expanded}}"]);
        expect(seen).toEqual([["already {{expanded}}"]]);
    });
});

describe("SessionHost lifecycle delegation", () => {
    test("newSession/switchSession/fork/importFromJsonl delegate to the lifecycle", async () => {
        const { host, lifecycle } = makeHost();
        await host.newSession({ parentSession: "p" });
        await host.switchSession("/path/a", undefined);
        await host.fork("entry1", { position: "before" });
        await host.importFromJsonl("/in.jsonl", "/cwd");
        const methods = (lifecycle.calls as Call[]).map((c) => c.method);
        expect(methods).toEqual(["newSession", "switchSession", "fork", "importFromJsonl"]);
        expect((lifecycle.calls as Call[])[1].args[0]).toBe("/path/a");
        expect((lifecycle.calls as Call[])[2].args).toEqual(["entry1", { position: "before" }]);
    });

    test("importFromJsonl throws when the lifecycle does not support it (headless)", () => {
        const { host } = makeHost({ withImport: false });
        expect(() => host.importFromJsonl("/in.jsonl")).toThrow(/not supported/);
    });
});

describe("SessionHost live-session reads", () => {
    test("session controls target the current session after replacement", async () => {
        const { host, setSession } = makeHost();
        const next = makeFakeSession({ getSteeringMessages: () => ["NEW"], getFollowUpMessages: () => [] });
        setSession(next);
        expect(host.getQueuedMessages()).toEqual({ steering: ["NEW"], followUp: [] });
        await host.abort();
        expect((next.calls as Call[]).some((c) => c.method === "abort")).toBe(true);
    });
});

describe("SessionHost passthroughs", () => {
    test("pendingMessageCount, abort, waitForIdle, setModel", async () => {
        const { host, session } = makeHost();
        expect(host.pendingMessageCount).toBe(3);
        await host.abort();
        await host.waitForIdle();
        await host.setModel({ id: "m" } as any);
        const methods = (session().calls as Call[]).map((c) => c.method);
        expect(methods).toEqual(["abort", "waitForIdle", "setModel"]);
    });
});

describe("runtimeSessionHost factory", () => {
    test("wires lifecycle + session reads to the AgentSessionRuntime", async () => {
        const calls: Call[] = [];
        const session = makeFakeSession();
        const runtime = {
            get session() {
                return session;
            },
            newSession: async (...a: unknown[]) => {
                calls.push({ method: "newSession", args: a });
                return { cancelled: false };
            },
            switchSession: async (...a: unknown[]) => {
                calls.push({ method: "switchSession", args: a });
                return { cancelled: false };
            },
            fork: async (...a: unknown[]) => {
                calls.push({ method: "fork", args: a });
                return { cancelled: false };
            },
            importFromJsonl: async (...a: unknown[]) => {
                calls.push({ method: "importFromJsonl", args: a });
                return { cancelled: false };
            },
        };
        const host = runtimeSessionHost(runtime as unknown as AgentSessionRuntime);
        await host.newSession();
        await host.fork("e1");
        await host.sendUserMessage("hi");
        expect(calls.map((c) => c.method)).toEqual(["newSession", "fork"]);
        expect((session.calls as Call[]).some((c) => c.method === "prompt")).toBe(true);
    });
});
