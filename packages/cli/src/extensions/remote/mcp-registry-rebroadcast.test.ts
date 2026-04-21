/**
 * Regression test for fix/mcp-startup-session-limbo:
 *
 * When MCP finishes loading after the relay has already broadcast its
 * initial capabilities snapshot, the remote lifecycle handlers must
 * re-broadcast capabilities so the web UI's model/command lists don't
 * stay stale until the viewer navigates away and back.
 */
import { describe, expect, mock, test } from "bun:test";

// We only exercise the mcp:registry_updated → forwardEvent(capabilities)
// wiring added in lifecycle-handlers.ts. The rest of registerLifecycleHandlers
// wires up listeners we don't need here, so we stub dependencies to the
// minimum surface area required.

mock.module("../remote-ask-user.js", () => ({
    registerAskUserTool: mock(() => {}),
    cancelPendingAskUserQuestion: mock(() => {}),
    consumePendingAskUserQuestionFromWeb: mock(() => false),
}));
mock.module("../remote-plan-mode.js", () => ({
    registerPlanModeTool: mock(() => {}),
    cancelPendingPlanMode: mock(() => {}),
    consumePendingPlanModeFromWeb: mock(() => false),
}));
mock.module("../update-todo.js", () => ({
    setTodoUpdateCallback: mock(() => {}),
    setTodoMetaEmitter: mock(() => {}),
}));
mock.module("../plan-mode/index.js", () => ({
    setPlanModeChangeCallback: mock(() => {}),
    setPlanModeMetaEmitter: mock(() => {}),
}));
mock.module("../remote-footer.js", () => ({ installFooter: mock(() => {}) }));
mock.module("./session-error-trigger.js", () => ({
    maybeFireSessionError: mock(() => {}),
}));
mock.module("./auto-close.js", () => ({ shouldAutoClose: mock(() => false) }));
mock.module("./chunked-delivery.js", () => ({
    emitSessionActive: mock(() => {}),
}));
mock.module("./connection.js", () => ({ isDisabled: mock(() => true) }));

const { registerLifecycleHandlers } = await import("./lifecycle-handlers.js");

type EventHandler = (...args: unknown[]) => void;

function makePi() {
    const piHandlers = new Map<string, EventHandler[]>();
    const eventHandlers = new Map<string, EventHandler[]>();
    return {
        piHandlers,
        eventHandlers,
        on: (event: string, handler: EventHandler) => {
            const list = piHandlers.get(event) ?? [];
            list.push(handler);
            piHandlers.set(event, list);
        },
        registerCommand: mock(() => {}),
        registerTool: mock(() => {}),
        setSessionName: mock(() => {}),
        events: {
            on: (event: string, handler: EventHandler) => {
                const list = eventHandlers.get(event) ?? [];
                list.push(handler);
                eventHandlers.set(event, list);
            },
            emit: (event: string, ...args: unknown[]) => {
                for (const h of eventHandlers.get(event) ?? []) h(...args);
            },
            off: mock(() => {}),
        },
    };
}

describe("mcp:registry_updated → capabilities re-broadcast", () => {
    test("forwards fresh capabilities to viewers when MCP registry updates", () => {
        const pi = makePi();
        const forwardEvent = mock((_ev: unknown) => {});

        const capabilitiesSnapshot = {
            type: "capabilities" as const,
            models: [],
            commands: [{ name: "new-command", description: "just added" }],
        };

        const rctx = {
            forwardEvent,
            buildCapabilitiesState: () => capabilitiesSnapshot,
            // Minimal fields needed by registerLifecycleHandlers — unused code
            // paths are triggered via isDisabled() -> true so connect never runs.
            isAgentActive: false,
            setRelayStatus: mock(() => {}),
            disconnectedStatusText: () => "Disconnected",
            latestCtx: null,
            sessionStartedAt: 0,
        } as any;

        registerLifecycleHandlers({
            pi: pi as any,
            rctx,
            state: {
                staleChildIds: new Set(),
                pendingDelink: false,
                pendingDelinkEpoch: null,
                pendingDelinkOwnParent: false,
                stalePrimaryParentId: null,
                pendingCancellations: [],
                sessionCompleteFired: false,
            },
            triggerWaits: { cancelAll: mock(() => 0) } as any,
            delinkManager: {} as any,
            cancellationManager: {} as any,
            followUpGrace: {
                clearFollowUpGrace: mock(() => {}),
                fireSessionComplete: mock(() => {}),
                shutdownFollowUpGraceImmediately: mock(() => {}),
            } as any,
            startSessionNameSync: mock(() => {}),
            stopSessionNameSync: mock(() => {}),
            doConnect: mock(() => {}),
            doDisconnect: mock(() => {}),
            clearCtx: mock(() => {}),
        });

        // Simulate MCP finishing a server init late in startup
        pi.events.emit("mcp:registry_updated", {
            server: "github",
            toolCount: 12,
            totalToolCount: 42,
        });

        // Find the capabilities forward call
        const capabilitiesCalls = forwardEvent.mock.calls.filter(
            (call) => (call[0] as any)?.type === "capabilities",
        );
        expect(capabilitiesCalls.length).toBeGreaterThanOrEqual(1);
        expect(capabilitiesCalls[0]![0]).toBe(capabilitiesSnapshot);
    });
});
