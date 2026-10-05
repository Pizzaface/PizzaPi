import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { DEFAULT_TUNNEL_RELAY_LIMITS } from "@pizzapi/tunnel";
import { createTestAuthContext } from "./auth.js";
import {
    disposeTunnelRelay,
    getTunnelRelay,
    handleTunnelRelayUpgrade,
    initTunnelRelay,
    readTunnelLimitsFromEnv,
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

describe("readTunnelLimitsFromEnv", () => {
    test("uses defaults when unset", () => {
        expect(readTunnelLimitsFromEnv({})).toEqual({ ...DEFAULT_TUNNEL_RELAY_LIMITS });
    });

    test("parses non-negative integers, including 0 to disable a limit", () => {
        const limits = readTunnelLimitsFromEnv({
            PIZZAPI_TUNNEL_MAX_REQUEST_BODY_BYTES: "2048",
            PIZZAPI_TUNNEL_MAX_RESPONSE_BODY_BYTES: "4096",
            PIZZAPI_TUNNEL_MAX_INFLIGHT_PER_RUNNER: "8",
            PIZZAPI_TUNNEL_MAX_BUFFERED_BYTES: "0",
        });
        expect(limits).toEqual({
            maxRequestBodyBytes: 2048,
            maxResponseBodyBytes: 4096,
            maxInFlightPerRunner: 8,
            maxBufferedBytes: 0,
        });
    });

    test("ignores malformed values and keeps the default", () => {
        const limits = readTunnelLimitsFromEnv({
            PIZZAPI_TUNNEL_MAX_REQUEST_BODY_BYTES: "10MB",
            PIZZAPI_TUNNEL_MAX_INFLIGHT_PER_RUNNER: "-1",
            PIZZAPI_TUNNEL_MAX_BUFFERED_BYTES: "1e9",
        });
        expect(limits).toEqual({ ...DEFAULT_TUNNEL_RELAY_LIMITS });
    });

    test("initTunnelRelay applies the environment limits", () => {
        const previous = process.env.PIZZAPI_TUNNEL_MAX_INFLIGHT_PER_RUNNER;
        process.env.PIZZAPI_TUNNEL_MAX_INFLIGHT_PER_RUNNER = "3";
        try {
            expect(initTunnelRelay(authContext).limits.maxInFlightPerRunner).toBe(3);
        } finally {
            if (previous === undefined) delete process.env.PIZZAPI_TUNNEL_MAX_INFLIGHT_PER_RUNNER;
            else process.env.PIZZAPI_TUNNEL_MAX_INFLIGHT_PER_RUNNER = previous;
        }
    });
});
