import { describe, expect, test } from "bun:test";
import { normalizeLoopbackHost } from "./relay-url.js";

describe("normalizeLoopbackHost", () => {
    test("rewrites localhost hosts to 127.0.0.1 across schemes", () => {
        expect(normalizeLoopbackHost("ws://localhost:7492")).toBe("ws://127.0.0.1:7492");
        expect(normalizeLoopbackHost("wss://localhost:7492")).toBe("wss://127.0.0.1:7492");
        expect(normalizeLoopbackHost("http://localhost:7492")).toBe("http://127.0.0.1:7492");
        expect(normalizeLoopbackHost("https://localhost:7492/path")).toBe("https://127.0.0.1:7492/path");
        expect(normalizeLoopbackHost("LOCALHOST:7492")).toBe("127.0.0.1:7492");
    });

    test("handles bare hosts and missing ports", () => {
        expect(normalizeLoopbackHost("localhost:7492")).toBe("127.0.0.1:7492");
        expect(normalizeLoopbackHost("localhost")).toBe("127.0.0.1");
        expect(normalizeLoopbackHost("ws://localhost")).toBe("ws://127.0.0.1");
        expect(normalizeLoopbackHost("ws://localhost/path")).toBe("ws://127.0.0.1/path");
    });

    test("preserves userinfo", () => {
        expect(normalizeLoopbackHost("http://user:pw@localhost:7492")).toBe("http://user:pw@127.0.0.1:7492");
    });

    test("leaves non-localhost hosts untouched", () => {
        expect(normalizeLoopbackHost("wss://relay.example.com")).toBe("wss://relay.example.com");
        expect(normalizeLoopbackHost("http://mylocalhost.com")).toBe("http://mylocalhost.com");
        expect(normalizeLoopbackHost("http://localhost.example.com")).toBe("http://localhost.example.com");
        expect(normalizeLoopbackHost("http://127.0.0.1:7492")).toBe("http://127.0.0.1:7492");
        expect(normalizeLoopbackHost("http://[::1]:7492")).toBe("http://[::1]:7492");
        expect(normalizeLoopbackHost("off")).toBe("off");
        expect(normalizeLoopbackHost("")).toBe("");
    });
});
