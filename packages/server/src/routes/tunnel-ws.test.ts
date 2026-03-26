import { describe, expect, test } from "bun:test";

describe("tunnel-ws module exports", () => {
    test("exports the expected handler functions", async () => {
        const mod = await import("./tunnel-ws.js");
        expect(typeof mod.handleTunnelWsUpgrade).toBe("function");
    });
});

describe("handleTunnelWsUpgrade path matching", () => {
    test("returns false for non-tunnel paths", async () => {
        const { handleTunnelWsUpgrade } = await import("./tunnel-ws.js");
        const { Duplex } = await import("node:stream");

        const socket = new Duplex({
            read() {},
            write(_chunk, _enc, cb) { cb(); },
        });

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

        await new Promise((resolve) => setTimeout(resolve, 200));
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

        await new Promise((resolve) => setTimeout(resolve, 200));
        socket.destroy();
    });
});
