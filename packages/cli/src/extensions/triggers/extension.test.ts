// ============================================================================
// extension.test.ts — Tests for the trigger extension's respond_to_trigger tool
//
// Verifies that acknowledging a session_complete trigger emits a
// cleanup_child_session event to the relay, and that followUp still works
// without emitting cleanup.
// ============================================================================

import { describe, it, expect, beforeEach } from "bun:test";
import { trackReceivedTrigger, receivedTriggers, sendTriggerResponseWithAck } from "./extension.js";

interface EmittedEvent {
    event: string;
    data: unknown;
}

function createMockSocket(opts?: { failSessionMessage?: boolean; failTriggerResponse?: boolean }) {
    const emitted: EmittedEvent[] = [];
    const listeners = new Map<string, ((...args: any[]) => void)[]>();

    return {
        emitted,
        socket: {
            emit(event: string, data: any, ack?: (result: { ok: boolean; error?: string }) => void) {
                emitted.push({ event, data });
                if (event === "session_message" && opts?.failSessionMessage) {
                    for (const handler of listeners.get("session_message_error") ?? []) {
                        handler({ targetSessionId: data.targetSessionId, error: "Target session not found or not connected" });
                    }
                }
                if (event === "trigger_response" && ack) {
                    ack(opts?.failTriggerResponse
                        ? { ok: false, error: "Sender is not the parent of the target session (linked relationship is broken or stale)" }
                        : { ok: true });
                }
                if (event === "cleanup_child_session" && ack) {
                    ack({ ok: true });
                }
            },
            on(event: string, handler: (...args: any[]) => void) {
                const handlers = listeners.get(event) ?? [];
                handlers.push(handler);
                listeners.set(event, handlers);
            },
            off(event: string, handler: (...args: any[]) => void) {
                const handlers = listeners.get(event) ?? [];
                listeners.set(event, handlers.filter(h => h !== handler));
            },
            connected: true,
        },
        token: "test-token",
    };
}

async function simulateRespondToTrigger(
    params: { triggerId: string; response: string; action?: string },
    conn: ReturnType<typeof createMockSocket>,
): Promise<{ text: string } | null> {
    const pending = receivedTriggers.get(params.triggerId);
    if (!pending) {
        return { text: `Error: No pending trigger with ID ${params.triggerId}` };
    }

    if (pending.type === "session_complete") {
        const action = params.action ?? "ack";
        if (action === "followUp") {
            const result = await new Promise<{ ok: boolean; text: string }>((resolve) => {
                const timeout = setTimeout(() => {
                    conn.socket.off("session_message_error", onError);
                    resolve({ ok: true, text: `Follow-up sent to child ${pending.sourceSessionId}` });
                }, 0);

                const onError = (err: { targetSessionId: string; error: string }) => {
                    if (err.targetSessionId === pending.sourceSessionId) {
                        clearTimeout(timeout);
                        conn.socket.off("session_message_error", onError);
                        resolve({ ok: false, text: `Error sending follow-up to child ${pending.sourceSessionId}: ${err.error}` });
                    }
                };
                conn.socket.on("session_message_error", onError);

                conn.socket.emit("session_message", {
                    token: conn.token,
                    targetSessionId: pending.sourceSessionId,
                    message: params.response,
                    deliverAs: "input",
                });
            });
            if (result.ok) {
                receivedTriggers.delete(params.triggerId);
            }
            return { text: result.text };
        }
        receivedTriggers.delete(params.triggerId);
        conn.socket.emit("cleanup_child_session", {
            token: conn.token,
            childSessionId: pending.sourceSessionId,
        });
        return { text: `Acknowledged session completion from ${pending.sourceSessionId}` };
    }

    const result = await sendTriggerResponseWithAck(conn as any, {
        triggerId: params.triggerId,
        response: params.response,
        action: params.action,
        targetSessionId: pending.sourceSessionId,
    });
    if (!result.ok) {
        return { text: `Failed to deliver response for trigger ${params.triggerId}: ${result.error ?? "unknown error"}` };
    }
    receivedTriggers.delete(params.triggerId);
    return { text: `Response sent for trigger ${params.triggerId}` };
}

describe("respond_to_trigger handling for session_complete", () => {
    beforeEach(() => {
        receivedTriggers.clear();
    });

    it("ack emits cleanup_child_session instead of trigger_response", async () => {
        const conn = createMockSocket();
        trackReceivedTrigger("trig_123", "child-abc", "session_complete");

        const result = await simulateRespondToTrigger(
            { triggerId: "trig_123", response: "Done, thanks!", action: "ack" },
            conn,
        );

        expect(result?.text).toBe("Acknowledged session completion from child-abc");
        expect(receivedTriggers.has("trig_123")).toBe(false);

        const cleanup = conn.emitted.find((e) => e.event === "cleanup_child_session");
        expect(cleanup).toBeDefined();
        expect(cleanup?.data).toEqual({
            token: "test-token",
            childSessionId: "child-abc",
        });

        const triggerResp = conn.emitted.find((e) => e.event === "trigger_response");
        expect(triggerResp).toBeUndefined();
    });

    it("default action for session_complete is ack (cleanup)", async () => {
        const conn = createMockSocket();
        trackReceivedTrigger("trig_456", "child-def", "session_complete");

        const result = await simulateRespondToTrigger(
            { triggerId: "trig_456", response: "Looks good" },
            conn,
        );

        expect(result?.text).toBe("Acknowledged session completion from child-def");
        expect(conn.emitted.some((e) => e.event === "cleanup_child_session")).toBe(true);
    });

    it("followUp sends session_message and does not emit cleanup", async () => {
        const conn = createMockSocket();
        trackReceivedTrigger("trig_789", "child-ghi", "session_complete");

        const result = await simulateRespondToTrigger(
            { triggerId: "trig_789", response: "Please fix the edge case and rerun tests", action: "followUp" },
            conn,
        );

        expect(result?.text).toBe("Follow-up sent to child child-ghi");
        expect(receivedTriggers.has("trig_789")).toBe(false);

        const msg = conn.emitted.find((e) => e.event === "session_message");
        expect(msg).toBeDefined();
        expect(msg?.data).toEqual({
            token: "test-token",
            targetSessionId: "child-ghi",
            message: "Please fix the edge case and rerun tests",
            deliverAs: "input",
        });

        const cleanup = conn.emitted.find((e) => e.event === "cleanup_child_session");
        expect(cleanup).toBeUndefined();
    });

    it("followUp preserves trigger when session_message delivery fails", async () => {
        const conn = createMockSocket({ failSessionMessage: true });
        trackReceivedTrigger("trig_fail", "child-missing", "session_complete");

        const result = await simulateRespondToTrigger(
            { triggerId: "trig_fail", response: "keep working", action: "followUp" },
            conn,
        );

        expect(result?.text).toContain("Error sending follow-up to child child-missing");
        expect(receivedTriggers.has("trig_fail")).toBe(true);
        expect(conn.emitted.some((e) => e.event === "cleanup_child_session")).toBe(false);
    });

    it("non-session_complete triggers still use trigger_response", async () => {
        const conn = createMockSocket();
        trackReceivedTrigger("trig_plan", "child-plan", "plan_review");

        const result = await simulateRespondToTrigger(
            { triggerId: "trig_plan", response: "Approved", action: "approve" },
            conn,
        );

        expect(result?.text).toBe("Response sent for trigger trig_plan");
        const triggerResp = conn.emitted.find((e) => e.event === "trigger_response");
        expect(triggerResp).toBeDefined();
        expect(triggerResp?.data).toEqual({
            token: "test-token",
            triggerId: "trig_plan",
            response: "Approved",
            action: "approve",
            targetSessionId: "child-plan",
        });
    });

    it("non-session_complete preserves trigger when relay rejects delivery", async () => {
        const conn = createMockSocket({ failTriggerResponse: true });
        trackReceivedTrigger("trig_plan_fail", "child-plan", "plan_review");

        const result = await simulateRespondToTrigger(
            { triggerId: "trig_plan_fail", response: "Approved", action: "approve" },
            conn,
        );

        expect(result?.text).toContain("Failed to deliver response for trigger trig_plan_fail");
        expect(receivedTriggers.has("trig_plan_fail")).toBe(true);
    });

    it("triggers never expire — an old pending trigger can still be responded to", async () => {
        const conn = createMockSocket();
        trackReceivedTrigger("trig_old", "child-old", "session_complete");
        const pending = receivedTriggers.get("trig_old");
        if (pending) pending.trackedAt = Date.now() - 60 * 60 * 1000; // 1 hour ago

        const result = await simulateRespondToTrigger(
            { triggerId: "trig_old", response: "late ack", action: "ack" },
            conn,
        );

        expect(result?.text).toBe("Acknowledged session completion from child-old");
        expect(receivedTriggers.has("trig_old")).toBe(false);
        expect(conn.emitted.some((e) => e.event === "cleanup_child_session")).toBe(true);
    });
});

// ============================================================================
// Built-in sigils & merge logic
// ============================================================================

import { BUILTIN_SIGIL_DEFS, mergeWithBuiltinSigils } from "./extension.js";
import type { ServiceSigilDef } from "@pizzapi/protocol";

describe("BUILTIN_SIGIL_DEFS", () => {
    it("contains the action sigil with confirm/choose/input variants", () => {
        const action = BUILTIN_SIGIL_DEFS.find((d) => d.type === "action");
        expect(action).toBeDefined();
        expect(action!.label).toBe("Action");
        const variantNames = (action!.variants ?? []).map((v) => v.name);
        expect(variantNames).toEqual(["confirm", "choose", "input"]);
    });

    it("contains file, status, error, and other utility sigils", () => {
        const types = BUILTIN_SIGIL_DEFS.map((d) => d.type);
        for (const expected of ["file", "status", "error", "cost", "duration", "session", "model", "cmd", "tag", "test", "link", "diff"]) {
            expect(types).toContain(expected);
        }
    });

    it("contains PizzaPi entity sigils (skill, runner, service, trigger, tunnel, agent)", () => {
        const types = BUILTIN_SIGIL_DEFS.map((d) => d.type);
        for (const expected of ["skill", "runner", "service", "trigger", "tunnel", "agent"]) {
            expect(types).toContain(expected);
        }
    });

    it("has no duplicate types", () => {
        const types = BUILTIN_SIGIL_DEFS.map((d) => d.type);
        expect(new Set(types).size).toBe(types.length);
    });

    it("every entry has type, label, and icon", () => {
        for (const def of BUILTIN_SIGIL_DEFS) {
            expect(def.type).toBeTruthy();
            expect(def.label).toBeTruthy();
            expect(def.icon).toBeTruthy();
        }
    });
});

describe("mergeWithBuiltinSigils", () => {
    it("returns only built-ins when no service defs provided", () => {
        const result = mergeWithBuiltinSigils([]);
        expect(result).toHaveLength(BUILTIN_SIGIL_DEFS.length);
        expect(result.map((d) => d.type)).toEqual(BUILTIN_SIGIL_DEFS.map((d) => d.type));
    });

    it("service defs appear first, then built-ins", () => {
        const serviceDef: ServiceSigilDef = { type: "pr", label: "Pull Request", serviceId: "github" };
        const result = mergeWithBuiltinSigils([serviceDef]);
        expect(result[0].type).toBe("pr");
        expect(result[0].serviceId).toBe("github");
        // Built-ins follow
        expect(result.slice(1).map((d) => d.type)).toEqual(BUILTIN_SIGIL_DEFS.map((d) => d.type));
    });

    it("service def overrides a built-in of the same type", () => {
        const serviceDef: ServiceSigilDef = {
            type: "file",
            label: "Custom File",
            serviceId: "my-service",
            resolve: "/api/resolve/file/{id}",
        };
        const result = mergeWithBuiltinSigils([serviceDef]);
        const fileDefs = result.filter((d) => d.type === "file");
        // Only one "file" entry — the service version
        expect(fileDefs).toHaveLength(1);
        expect(fileDefs[0].label).toBe("Custom File");
        expect(fileDefs[0].serviceId).toBe("my-service");
    });

    it("does not duplicate when service provides multiple overlapping types", () => {
        const serviceDefs: ServiceSigilDef[] = [
            { type: "file", label: "Svc File" },
            { type: "error", label: "Svc Error" },
            { type: "idea", label: "Idea", serviceId: "godmother" },
        ];
        const result = mergeWithBuiltinSigils(serviceDefs);
        // Total = service defs + (built-ins minus any the services override)
        const expectedCount = serviceDefs.length + BUILTIN_SIGIL_DEFS.filter(
            (b) => !serviceDefs.some((s) => s.type === b.type),
        ).length;
        expect(result).toHaveLength(expectedCount);
        // No duplicates
        const types = result.map((d) => d.type);
        expect(new Set(types).size).toBe(types.length);
    });
});

// ============================================================================
// list_available_sigils — child-session action sigil omission
// ============================================================================

import { triggersExtension } from "./extension.js";
import { getRelaySessionId } from "../remote.js";
import { afterEach } from "bun:test";

function registerTriggersTools(): Map<string, any> {
    const tools = new Map<string, any>();
    triggersExtension({ registerTool: (t: any) => tools.set(t.name, t) } as any);
    return tools;
}

async function listSigilsText(sessionId?: string): Promise<string> {
    const tool = registerTriggersTools().get("list_available_sigils")!;
    const result = await tool.execute("t0", sessionId ? { sessionId } : {});
    return result.content[0].text as string;
}

describe("list_available_sigils", () => {
    const ENV_KEY = "PIZZAPI_WORKER_PARENT_SESSION_ID";
    const RELAY_URL_KEY = "PIZZAPI_RELAY_URL"; // "off" short-circuits getAvailableSigils → deterministic offline
    const SESSION_ID_KEY = "PIZZAPI_SESSION_ID"; // controls getRelaySessionId() in tests
    let prevParent: string | undefined;
    let prevRelayUrl: string | undefined;
    let prevSessionId: string | undefined;

    beforeEach(() => {
        prevParent = process.env[ENV_KEY];
        prevRelayUrl = process.env[RELAY_URL_KEY];
        prevSessionId = process.env[SESSION_ID_KEY];
        process.env[RELAY_URL_KEY] = "off";
    });

    afterEach(() => {
        if (prevParent === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = prevParent;
        if (prevRelayUrl === undefined) delete process.env[RELAY_URL_KEY];
        else process.env[RELAY_URL_KEY] = prevRelayUrl;
        if (prevSessionId === undefined) delete process.env[SESSION_ID_KEY];
        else process.env[SESSION_ID_KEY] = prevSessionId;
    });

    it("omits action and points to AskUserQuestion for child self-queries", async () => {
        process.env[ENV_KEY] = "parent-1";
        const text = await listSigilsText();
        expect(text).not.toContain("• action");
        expect(text).toContain(`Available sigils (${BUILTIN_SIGIL_DEFS.length - 1})`);
        expect(text).toContain("AskUserQuestion");
        expect(text).toContain("action sigil is omitted");
    });

    it("keeps action (with canonical example) in top-level sessions", async () => {
        delete process.env[ENV_KEY];
        const text = await listSigilsText();
        expect(text).toContain("• action");
        expect(text).toContain(`Available sigils (${BUILTIN_SIGIL_DEFS.length})`);
        expect(text).toContain('Example: [[action:confirm question="Proceed to implementation?"]]');
        expect(text).not.toContain("action sigil is omitted");
    });

    it("keeps action when a parent explicitly queries another session", async () => {
        delete process.env[ENV_KEY];
        // Parent context: env unset, explicit target session — action stays.
        const text = await listSigilsText("child-9");
        expect(text).toContain("• action");
    });

    it("omits action when a child explicitly queries its own session id", async () => {
        process.env[ENV_KEY] = "parent-1";
        process.env[SESSION_ID_KEY] = "child-77";
        // Resolve own id the same way the tool does — in full-suite runs
        // new-session-cleanup.test.ts's mock.module pins getRelaySessionId()
        // to "parent-session-1", so env is only authoritative in isolation.
        const ownId = getRelaySessionId() ?? "child-77";
        const text = await listSigilsText(ownId);
        expect(text).not.toContain("• action");
        expect(text).toContain("AskUserQuestion");
    });

    it("keeps action when a child queries a different session", async () => {
        process.env[ENV_KEY] = "parent-1";
        process.env[SESSION_ID_KEY] = "child-77";
        const otherId = `${getRelaySessionId() ?? "child-77"}-other`;
        const text = await listSigilsText(otherId);
        expect(text).toContain("• action");
    });
});
