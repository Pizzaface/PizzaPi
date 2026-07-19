import { describe, test, expect } from "bun:test";
import {
    parseRecordedGroupPids,
    parsePsFullLine,
    selectGroupProcesses,
    stripCapturePrefix,
    sessionProcFilePath,
    SHELL_PROC_CAPTURE_PREFIX,
} from "./session-procs.js";

describe("parseRecordedGroupPids", () => {
    test("dedupes and drops garbage", () => {
        expect(parseRecordedGroupPids("100\n200\n100\n\n-3\nabc\n0\n300\n")).toEqual([100, 200, 300]);
    });
    test("empty content", () => {
        expect(parseRecordedGroupPids("")).toEqual([]);
    });
});

describe("parsePsFullLine", () => {
    test("parses pid pgid etime rss command", () => {
        expect(parsePsFullLine("  1234  1200 02:13 51200 bun run dev --port 3000")).toEqual({
            pid: 1234,
            pgid: 1200,
            etime: "02:13",
            rssKb: 51200,
            command: "bun run dev --port 3000",
        });
    });
    test("parses day-form etime", () => {
        expect(parsePsFullLine("99999 99999 1-04:00:00 8 node server.js")?.etime).toBe("1-04:00:00");
    });
    test("rejects garbage", () => {
        expect(parsePsFullLine("")).toBeNull();
        expect(parsePsFullLine("not a ps line")).toBeNull();
    });
});

describe("stripCapturePrefix", () => {
    test("removes the capture prefix (ps octal-escaped newline)", () => {
        const line = `/bin/bash -c ${SHELL_PROC_CAPTURE_PREFIX}\\012sleep 3600`;
        // ps shows the whole -c arg; the real command should survive
        expect(stripCapturePrefix(line)).toBe("sleep 3600");
    });
    test("removes the capture prefix (real newline)", () => {
        const line = `${SHELL_PROC_CAPTURE_PREFIX}\nnpm run build`;
        expect(stripCapturePrefix(line)).toBe("npm run build");
    });
    test("leaves ordinary commands untouched", () => {
        expect(stripCapturePrefix("/usr/bin/node server.js")).toBe("/usr/bin/node server.js");
    });
});

describe("selectGroupProcesses", () => {
    const snapshot = [
        "  1     1 13-00:00:00 20000 /sbin/launchd",
        "100   100 05:00 4000 /worker",
        "200   100 04:59 8000 gm serve", // worker group inline child
        "555   555 03:00 3000 /bin/bash -c sleep 3600", // recorded bash group leader
        "556   555 03:00 1000 sleep 3600", // orphaned background child in recorded group
        "900   900 01:00 500 unrelated",
    ].join("\n");

    test("selects worker group + recorded groups, reports live groups", () => {
        const { processes, liveGroups } = selectGroupProcesses(snapshot, new Set([100, 555]));
        expect(processes.map((p) => p.pid).sort((a, b) => a - b)).toEqual([100, 200, 555, 556]);
        expect([...liveGroups].sort((a, b) => a - b)).toEqual([100, 555]);
        // unrelated system processes are excluded
        expect(processes.some((p) => p.pid === 1 || p.pid === 900)).toBe(false);
    });

    test("catches an orphaned background process via its recorded group", () => {
        // Only the recorded bash group (555) is known — worker group absent.
        const { processes } = selectGroupProcesses(snapshot, new Set([555]));
        expect(processes.map((p) => p.pid).sort((a, b) => a - b)).toEqual([555, 556]);
        expect(processes.find((p) => p.pid === 556)?.command).toBe("sleep 3600");
    });
});

describe("sessionProcFilePath", () => {
    test("sanitizes session ids into a safe filename", () => {
        // Path separators are stripped (no traversal); dots are harmless once
        // slashes are gone.
        const p = sessionProcFilePath("abc/../etc");
        expect(p.endsWith("abc_.._etc.pids")).toBe(true);
        expect(p.includes("/../")).toBe(false);
    });
});
