import { describe, expect, test } from "bun:test";
import { parseCliOptions } from "./sandbox.js";

describe("parseCliOptions", () => {
    test("defaults to memory redis and interactive mode", () => {
        expect(parseCliOptions([])).toEqual({
            requestedPort: 0,
            headless: false,
            redisMode: "memory",
        });
    });

    test("parses numeric port and headless flag", () => {
        expect(parseCliOptions(["4321", "--headless"])).toEqual({
            requestedPort: 4321,
            headless: true,
            redisMode: "memory",
        });
    });

    test("parses explicit redis mode", () => {
        expect(parseCliOptions(["--redis=docker"])).toEqual({
            requestedPort: 0,
            headless: false,
            redisMode: "docker",
        });
        expect(parseCliOptions(["--redis=env", "9999"])).toEqual({
            requestedPort: 9999,
            headless: false,
            redisMode: "env",
        });
    });

    test("rejects invalid redis mode", () => {
        expect(() => parseCliOptions(["--redis=wat"])).toThrow(
            "Invalid --redis mode: wat",
        );
    });
});
