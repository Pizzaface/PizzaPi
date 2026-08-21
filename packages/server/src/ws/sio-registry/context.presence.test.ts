import { describe, expect, it } from "bun:test";
import { countSocketsInRoomCluster, emitToRelaySessionChecked, initSioRegistry } from "./context.js";

function namespace(fetchSockets: () => Promise<unknown[]>) {
    return {
        name: "/relay",
        adapter: { sockets: async () => new Set<string>() }, // local node is empty
        in: () => ({ fetchSockets }),
        to: () => ({
            timeout: () => ({
                emit: (_event: string, _data: unknown, ack: (err: unknown, responses?: unknown[]) => void) => ack(null, [{ ok: true }]),
            }),
        }),
    };
}

describe("countSocketsInRoomCluster", () => {
    it("uses cluster fetchSockets rather than the empty local adapter room", async () => {
        const relay = namespace(async () => [{ id: "remote-socket" }]);
        await expect(countSocketsInRoomCluster(relay as never, "session:s1")).resolves.toEqual({ kind: "count", count: 1 });
    });

    it("returns unknown when the cluster lookup fails", async () => {
        const relay = namespace(async () => { throw new Error("redis down"); });
        await expect(countSocketsInRoomCluster(relay as never, "session:s1")).resolves.toEqual({ kind: "unknown" });
    });

    it("returns unknown when the lookup exceeds its timeout", async () => {
        const relay = namespace(() => new Promise(() => {}));
        await expect(countSocketsInRoomCluster(relay as never, "session:timeout", { timeoutMs: 1 })).resolves.toEqual({ kind: "unknown" });
    });

    it("coalesces concurrent lookups for the same namespace room", async () => {
        let calls = 0;
        let resolveFetch: (sockets: unknown[]) => void = () => {};
        const relay = namespace(() => {
            calls++;
            return new Promise((resolve) => { resolveFetch = resolve; });
        });
        const first = countSocketsInRoomCluster(relay as never, "session:s1");
        const second = countSocketsInRoomCluster(relay as never, "session:s1");
        resolveFetch([]);
        await expect(Promise.all([first, second])).resolves.toEqual([
            { kind: "count", count: 0 },
            { kind: "count", count: 0 },
        ]);
        expect(calls).toBe(1);
    });
});

describe("emitToRelaySessionChecked", () => {
    it("uses the local adapter for a known-local recipient during a Redis failure", async () => {
        let emitted = false;
        const relay = {
            name: "/relay",
            adapter: { rooms: new Map([["session:s1", new Set(["local-socket"]) ]]) },
            local: { to: () => ({ emit: () => { emitted = true; } }) },
            to: () => { throw new Error("Redis adapter must not be used"); },
        };
        initSioRegistry({ of: () => relay } as never);

        await expect(emitToRelaySessionChecked("s1", "event", {})).resolves.toBe("delivered");
        expect(emitted).toBe(true);
    });
});

