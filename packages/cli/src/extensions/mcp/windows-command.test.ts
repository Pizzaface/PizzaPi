import { describe, expect, test } from "bun:test";
import { buildSpawnInvocation, quoteForCmd, resolveWindowsExecutable } from "./windows-command.js";

describe("quoteForCmd", () => {
    test("passes plain args through", () => {
        expect(quoteForCmd("plain")).toBe("plain");
        expect(quoteForCmd("-y")).toBe("-y");
        expect(quoteForCmd("@modelcontextprotocol/server-filesystem")).toBe("@modelcontextprotocol/server-filesystem");
    });

    test("quotes whitespace and cmd metacharacters", () => {
        expect(quoteForCmd("hello world")).toBe('"hello world"');
        expect(quoteForCmd("a&b")).toBe('"a&b"');
        expect(quoteForCmd("")).toBe('""');
    });

    test("escapes embedded quotes", () => {
        expect(quoteForCmd('say "hi"')).toBe('"say \\"hi\\""');
    });
});

describe("buildSpawnInvocation", () => {
    test("is the identity on POSIX or for unresolvable commands", () => {
        const inv = buildSpawnInvocation("definitely-not-a-real-command-xyz", ["a", "b"]);
        expect(inv.command).toBe("definitely-not-a-real-command-xyz");
        expect(inv.args).toEqual(["a", "b"]);
        expect(inv.windowsVerbatimArguments).toBeUndefined();
    });

    test.if(process.platform === "win32")("routes .cmd shims through cmd.exe", () => {
        // npx.cmd ships with Node — present on any dev machine with npm.
        const resolved = resolveWindowsExecutable("npx");
        if (!resolved) return; // no Node install — nothing to assert
        expect(resolved.toLowerCase().endsWith(".cmd")).toBe(true);

        const inv = buildSpawnInvocation("npx", ["-y", "some-pkg"]);
        expect(inv.command.toLowerCase()).toContain("cmd.exe");
        expect(inv.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
        expect(inv.args[3]).toContain("npx.cmd");
        expect(inv.windowsVerbatimArguments).toBe(true);
    });

    test.if(process.platform === "win32")("spawns real executables directly by resolved path", () => {
        const inv = buildSpawnInvocation("cmd", ["/c", "echo hi"]);
        expect(inv.command.toLowerCase().endsWith("cmd.exe")).toBe(true);
        expect(inv.windowsVerbatimArguments).toBeUndefined();
    });
});
