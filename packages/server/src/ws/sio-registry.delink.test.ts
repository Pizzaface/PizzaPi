import { describe, expect, it } from "bun:test";
import { emitToRelaySessionAwaitingAck, initSioRegistry } from "./sio-registry.js";
import { severStaleParentLink } from "./stale-parent-link.js";

describe("sio-registry delink helpers", () => {
    it("waits for stale-child removal before reporting the child as unlinked", async () => {
        const calls: string[] = [];
        let sawRemoveChild = false;
        let resolveRemoveChild: () => void = () => {
            throw new Error("removeChildSession was not awaited");
        };

        const promise = severStaleParentLink({
            parentSessionId: "parent-1",
            childSessionId: "child-1",
            clearParentField: true,
            clearParentSessionId: async () => {
                calls.push("clear-parent");
            },
            removeChildSession: async () => {
                sawRemoveChild = true;
                calls.push("remove-child:start");
                await new Promise<void>((resolve) => {
                    resolveRemoveChild = () => {
                        calls.push("remove-child:done");
                        resolve();
                    };
                });
            },
        });

        let resolved = false;
        promise.then(() => {
            resolved = true;
        });

        await Promise.resolve();
        expect(calls).toEqual(["clear-parent", "remove-child:start"]);
        expect(resolved).toBe(false);

        if (!sawRemoveChild) throw new Error("removeChildSession was not awaited");
        resolveRemoveChild();
        await promise;

        expect(calls).toEqual(["clear-parent", "remove-child:start", "remove-child:done"]);
        expect(resolved).toBe(true);
    });

    it("confirms parent_delinked delivery when a relay socket acks", async () => {
        const relayNamespace = {
            in: (_room: string) => ({
                fetchSockets: async () => [{ id: "socket-1" }],
            }),
            to: (_room: string) => ({
                timeout: (_timeoutMs: number) => ({
                    emit: (_eventName: string, _data: unknown, ack: (err: unknown, responses?: unknown[]) => void) => {
                        ack(null, [{ ok: true }]);
                    },
                }),
            }),
        };

        initSioRegistry({
            of: () => relayNamespace,
        } as any);

        await expect(emitToRelaySessionAwaitingAck("child-1", "parent_delinked", { parentSessionId: "parent-1" })).resolves.toEqual({
            hadListeners: true,
            acked: true,
        });
    });

    it("reports failure when listeners exist but none ack parent_delinked", async () => {
        const relayNamespace = {
            in: (_room: string) => ({
                fetchSockets: async () => [{ id: "socket-1" }],
            }),
            to: (_room: string) => ({
                timeout: (_timeoutMs: number) => ({
                    emit: (_eventName: string, _data: unknown, ack: (err: unknown, responses?: unknown[]) => void) => {
                        ack(new Error("timeout"), []);
                    },
                }),
            }),
        };

        initSioRegistry({
            of: () => relayNamespace,
        } as any);

        await expect(emitToRelaySessionAwaitingAck("child-1", "parent_delinked", { parentSessionId: "parent-1" })).resolves.toEqual({
            hadListeners: true,
            acked: false,
        });
    });
});
