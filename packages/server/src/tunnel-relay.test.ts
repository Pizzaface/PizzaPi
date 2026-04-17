import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { createTestAuthContext } from "./auth.js";
import {
    disposeTunnelRelay,
    getTunnelRelay,
    handleTunnelRelayUpgrade,
    initTunnelRelay,
} from "./tunnel-relay.js";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-tunnel-relay-test-"));
const authContext = createTestAuthContext({ dbPath: join(tmpDir, "test.db") });

afterEach(() => {
    disposeTunnelRelay();
});

afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("tunnel-relay singleton", () => {
    test("initTunnelRelay returns the same instance until disposed", () => {
        const first = initTunnelRelay(authContext);
        const second = initTunnelRelay(authContext);

        expect(second).toBe(first);
        expect(getTunnelRelay()).toBe(first);
    });

    test("disposeTunnelRelay clears the singleton", () => {
        initTunnelRelay(authContext);
        expect(getTunnelRelay()).not.toBeNull();

        disposeTunnelRelay();

        expect(getTunnelRelay()).toBeNull();
    });
});

describe("handleTunnelRelayUpgrade path matching", () => {
    test("returns false for non-relay paths", () => {
        initTunnelRelay(authContext);

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
