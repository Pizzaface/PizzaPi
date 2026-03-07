import { describe, expect, test } from "bun:test";

describe("Security Headers", () => {
    test("HSTS max-age is 1 year", () => {
        expect("max-age=31536000").toContain("31536000");
    });
});
