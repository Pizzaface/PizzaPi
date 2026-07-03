import { describe, test, expect } from "bun:test";
import { mobileCorsHeaders } from "./mobile-links.js";

function reqWithOrigin(origin: string): Request {
    return new Request("http://example.com/api/mobile-link", { headers: { origin } });
}

describe("mobileCorsHeaders", () => {
    test("reflects a trusted origin", () => {
        const headers = mobileCorsHeaders(reqWithOrigin("https://app.example.com"), ["https://app.example.com"]);
        expect(headers["Access-Control-Allow-Origin"]).toBe("https://app.example.com");
        expect(headers["Vary"]).toBe("Origin");
    });

    test("reflects a known Capacitor origin", () => {
        for (const origin of ["capacitor://localhost", "http://localhost", "ionic://localhost", "null"]) {
            const headers = mobileCorsHeaders(reqWithOrigin(origin), []);
            expect(headers["Access-Control-Allow-Origin"]).toBe(origin);
        }
    });

    test("rejects arbitrary origins and falls back to the first trusted origin", () => {
        const headers = mobileCorsHeaders(reqWithOrigin("https://evil.com"), ["https://app.example.com"]);
        expect(headers["Access-Control-Allow-Origin"]).toBe("https://app.example.com");
    });

    test("falls back to * when no trusted origins are configured", () => {
        const headers = mobileCorsHeaders(reqWithOrigin("https://evil.com"), []);
        expect(headers["Access-Control-Allow-Origin"]).toBe("*");
    });

    test("falls back to the first trusted origin when no Origin header is present", () => {
        const req = new Request("http://example.com/api/mobile-link");
        const headers = mobileCorsHeaders(req, ["https://app.example.com"]);
        expect(headers["Access-Control-Allow-Origin"]).toBe("https://app.example.com");
    });
});
