import { afterEach, describe, expect, test } from "bun:test";
import { Duplex } from "node:stream";
import {
    disposeTunnelRelay,
    getTunnelRelay,
    handleTunnelRelayUpgrade,
    initTunnelRelay,
} from "./tunnel-relay.js";

afterEach(() => {
    disposeTunnelRelay();
});

describe("tunnel-relay singleton", () => {
    test("initTunnelRelay returns the same instance until disposed", () => {
        const first = initTunnelRelay();
        const second = initTunnelRelay();

        expect(second).toBe(first);
        expect(getTunnelRelay()).toBe(first);
    });

    test("disposeTunnelRelay clears the singleton", () => {
        initTunnelRelay();
        expect(getTunnelRelay()).not.toBeNull();

        disposeTunnelRelay();

        expect(getTunnelRelay()).toBeNull();
    });
});

describe("handleTunnelRelayUpgrade path matching", () => {
    test("returns false for non-relay paths", () => {
        initTunnelRelay();

        const socket = new Duplex({
            read() {},
            write(_chunk, _enc, callback) {
                callback();
            },
        });

        expect(
            handleTunnelRelayUpgrade(
                { url: "/socket.io/?EIO=4&transport=websocket" } as any,
                socket,
                Buffer.alloc(0),
            ),
        ).toBe(false);

        socket.destroy();
    });
});
