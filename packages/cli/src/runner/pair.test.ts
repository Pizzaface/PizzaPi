import { describe, test, expect } from "bun:test";
import { decidePairAction, isDaemonRunning, resolveCredentialSource } from "./pair.js";

describe("resolveCredentialSource", () => {
    test("no credential anywhere", () => {
        expect(resolveCredentialSource({}, false)).toBeUndefined();
    });

    test("config only", () => {
        expect(resolveCredentialSource({}, true)).toBe("config.json");
    });

    test("PIZZAPI_RUNNER_API_KEY wins over everything, including config", () => {
        expect(resolveCredentialSource({ PIZZAPI_RUNNER_API_KEY: "x", PIZZAPI_API_KEY: "y", PIZZAPI_API_TOKEN: "z" }, true)).toBe(
            "PIZZAPI_RUNNER_API_KEY",
        );
    });

    test("PIZZAPI_API_KEY wins over PIZZAPI_API_TOKEN and config", () => {
        expect(resolveCredentialSource({ PIZZAPI_API_KEY: "y", PIZZAPI_API_TOKEN: "z" }, true)).toBe("PIZZAPI_API_KEY");
    });

    test("PIZZAPI_API_TOKEN wins over config", () => {
        expect(resolveCredentialSource({ PIZZAPI_API_TOKEN: "z" }, true)).toBe("PIZZAPI_API_TOKEN");
    });
});

describe("decidePairAction", () => {
    test("nothing configured, no --force: proceeds cleanly", () => {
        const d = decidePairAction(undefined, false);
        expect(d).toEqual({ proceed: true });
    });

    test("config-only credential, no --force: refuses", () => {
        const d = decidePairAction("config.json", false);
        expect(d.proceed).toBe(false);
        expect(d.refusalReason).toContain("--force");
        expect(d.refusalReason).not.toContain("PIZZAPI_"); // no env var involved
    });

    test("config-only credential, --force: proceeds with no shadow warning", () => {
        const d = decidePairAction("config.json", true);
        expect(d).toEqual({ proceed: true });
    });

    for (const envVar of ["PIZZAPI_RUNNER_API_KEY", "PIZZAPI_API_KEY", "PIZZAPI_API_TOKEN"] as const) {
        test(`env-shadowed by ${envVar}, no --force: refuses and names the variable`, () => {
            const d = decidePairAction(envVar, false);
            expect(d.proceed).toBe(false);
            expect(d.refusalReason).toContain(envVar);
            expect(d.refusalReason).toContain("--force");
        });

        test(`env-shadowed by ${envVar}, --force: proceeds but with a loud warning naming it`, () => {
            const d = decidePairAction(envVar, true);
            expect(d.proceed).toBe(true);
            expect(d.warning).toBeDefined();
            expect(d.warning).toContain(envVar);
        });
    }

    test("refusal message never echoes a key value — only the source label", () => {
        const d = decidePairAction("PIZZAPI_API_KEY", false);
        // sanity: message is built purely from the source label, no interpolated secret
        expect(d.refusalReason).not.toMatch(/[0-9a-f]{16,}/);
    });
});

describe("isDaemonRunning", () => {
    const alive = (_pid: number) => true;
    const dead = (_pid: number) => false;

    test("no state file: not running", () => {
        expect(isDaemonRunning(null, alive)).toBe(false);
    });

    test("state with alive pid: running", () => {
        expect(isDaemonRunning({ pid: 123 }, alive)).toBe(true);
    });

    test("state with dead pid: not running", () => {
        expect(isDaemonRunning({ pid: 123 }, dead)).toBe(false);
    });

    test("state with pid 0 (released lock): not running", () => {
        expect(isDaemonRunning({ pid: 0 }, alive)).toBe(false);
    });

    test("state with no pid field: not running", () => {
        expect(isDaemonRunning({}, alive)).toBe(false);
    });
});
