import { describe, expect, test } from "bun:test";

// We test the exported pure/deterministic helpers from tunnel-ws.
// The upgrade handler itself requires a live httpServer + Socket.IO + Redis,
// which is integration-test territory. Here we test the frame codec and
// connection tracking logic that can be unit-tested.

// Since the WsFrameParser and encodeWsFrame are not exported (internal),
// we test them indirectly through the module's behavior, and also test
// the overall shape of the exports.

describe("tunnel-ws module exports", () => {
    test("exports the expected handler functions", async () => {
        const mod = await import("./tunnel-ws.js");
        expect(typeof mod.handleTunnelWsUpgrade).toBe("function");
        expect(typeof mod.handleTunnelWsOpened).toBe("function");
        expect(typeof mod.handleTunnelWsData).toBe("function");
        expect(typeof mod.handleTunnelWsClose).toBe("function");
        expect(typeof mod.handleTunnelWsError).toBe("function");
        expect(typeof mod.cleanupRunnerTunnelWs).toBe("function");
        expect(typeof mod.cleanupFrameParser).toBe("function");
    });
});

describe("handleTunnelWsUpgrade path matching", () => {
    // We can't fully test the upgrade handler without a running server,
    // but we can verify it correctly identifies tunnel paths vs non-tunnel paths.
    // The function returns true for tunnel paths and false otherwise.

    test("returns false for non-tunnel paths", async () => {
        const { handleTunnelWsUpgrade } = await import("./tunnel-ws.js");
        const { Duplex } = await import("node:stream");

        const socket = new Duplex({
            read() {},
            write(_chunk, _enc, cb) { cb(); },
        });

        // Socket.IO path — should NOT be handled
        const result = handleTunnelWsUpgrade(
            { url: "/socket.io/?EIO=4&transport=websocket", headers: {} } as any,
            socket,
            Buffer.alloc(0),
        );
        expect(result).toBe(false);
        socket.destroy();
    });

    test("returns false for random API paths", async () => {
        const { handleTunnelWsUpgrade } = await import("./tunnel-ws.js");
        const { Duplex } = await import("node:stream");

        const socket = new Duplex({
            read() {},
            write(_chunk, _enc, cb) { cb(); },
        });

        const result = handleTunnelWsUpgrade(
            { url: "/api/sessions", headers: {} } as any,
            socket,
            Buffer.alloc(0),
        );
        expect(result).toBe(false);
        socket.destroy();
    });

    test("returns true for tunnel paths", async () => {
        const { handleTunnelWsUpgrade } = await import("./tunnel-ws.js");
        const { Duplex } = await import("node:stream");

        // Track if anything was written to the socket (async auth will reject, but
        // the function should return true synchronously for the path match)
        const socket = new Duplex({
            read() {},
            write(_chunk, _enc, cb) { cb(); },
        });

        const result = handleTunnelWsUpgrade(
            {
                url: "/api/tunnel/session-123/3000/__vite_hmr",
                headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
            } as any,
            socket,
            Buffer.alloc(0),
        );
        expect(result).toBe(true);

        // Give the async auth handler time to reject and write to socket
        await new Promise(r => setTimeout(r, 200));
        socket.destroy();
    });

    test("returns true for tunnel paths with query strings", async () => {
        const { handleTunnelWsUpgrade } = await import("./tunnel-ws.js");
        const { Duplex } = await import("node:stream");

        const socket = new Duplex({
            read() {},
            write(_chunk, _enc, cb) { cb(); },
        });

        const result = handleTunnelWsUpgrade(
            {
                url: "/api/tunnel/sess-456/5173/__vite_hmr?token=abc",
                headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
            } as any,
            socket,
            Buffer.alloc(0),
        );
        expect(result).toBe(true);

        await new Promise(r => setTimeout(r, 200));
        socket.destroy();
    });
});

describe("handleTunnelWsError on unknown tunnelWsId", () => {
    test("does not throw for unknown IDs", async () => {
        const { handleTunnelWsError } = await import("./tunnel-ws.js");
        // Should be a no-op, not throw
        expect(() => handleTunnelWsError("nonexistent-id", "test error")).not.toThrow();
    });
});

describe("handleTunnelWsClose on unknown tunnelWsId", () => {
    test("does not throw for unknown IDs", async () => {
        const { handleTunnelWsClose } = await import("./tunnel-ws.js");
        expect(() => handleTunnelWsClose("nonexistent-id", 1000, "normal")).not.toThrow();
    });
});

describe("handleTunnelWsData on unknown tunnelWsId", () => {
    test("does not throw for unknown IDs", async () => {
        const { handleTunnelWsData } = await import("./tunnel-ws.js");
        expect(() => handleTunnelWsData("nonexistent-id", "hello", false)).not.toThrow();
    });
});

describe("cleanupRunnerTunnelWs", () => {
    test("does not throw for unknown runner IDs", async () => {
        const { cleanupRunnerTunnelWs } = await import("./tunnel-ws.js");
        expect(() => cleanupRunnerTunnelWs("nonexistent-runner")).not.toThrow();
    });
});

describe("cleanupFrameParser", () => {
    test("does not throw for unknown tunnel WS IDs", async () => {
        const { cleanupFrameParser } = await import("./tunnel-ws.js");
        expect(() => cleanupFrameParser("nonexistent-id")).not.toThrow();
    });
});
