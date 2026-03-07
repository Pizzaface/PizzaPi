import { describe, expect, test } from "bun:test";
import { getClientIp, rateLimitResponse } from "./rate-limiters";

describe("getClientIp", () => {
    test("extracts IP from X-Forwarded-For", () => {
        const req = new Request("http://localhost", { headers: { "x-forwarded-for": "1.2.3.4" } });
        expect(getClientIp(req)).toBe("1.2.3.4");
    });
});

describe("rateLimitResponse", () => {
    test("returns 429", () => {
        expect(rateLimitResponse().status).toBe(429);
    });
});
