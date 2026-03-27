import { describe, expect, test, beforeEach } from "bun:test";
import { handleApi, parseJsonArray } from "./index";
import { normalizePath, cwdMatchesRoots } from "../security";
import { serverHealth } from "../health";

// ── normalizePath ───────────────────────────────────────────────────────────

describe("normalizePath", () => {
    test("trims whitespace", () => {
        expect(normalizePath("  /home/user  ")).toBe("/home/user");
    });

    test("converts backslashes to forward slashes", () => {
        expect(normalizePath("C:\\Users\\me\\code")).toBe("C:/Users/me/code");
    });

    test("strips trailing slashes (except root)", () => {
        expect(normalizePath("/home/user/")).toBe("/home/user");
        expect(normalizePath("/home/user///")).toBe("/home/user");
    });

    test("preserves single-char paths (root)", () => {
        expect(normalizePath("/")).toBe("/");
    });

    test("handles Windows drive root", () => {
        expect(normalizePath("C:\\")).toBe("C:");
    });

    test("handles empty-ish strings", () => {
        expect(normalizePath("")).toBe("");
        expect(normalizePath("   ")).toBe("");
    });
});

// ── parseJsonArray (re-exported from utils) ─────────────────────────────────

describe("parseJsonArray", () => {
    test("parses valid JSON array", () => {
        expect(parseJsonArray('[1, 2, 3]')).toEqual([1, 2, 3]);
    });

    test("parses array of strings", () => {
        expect(parseJsonArray('["a", "b"]')).toEqual(["a", "b"]);
    });

    test("returns empty array for null/undefined/empty", () => {
        expect(parseJsonArray(null)).toEqual([]);
        expect(parseJsonArray(undefined)).toEqual([]);
        expect(parseJsonArray("")).toEqual([]);
    });

    test("returns empty array for non-array JSON", () => {
        expect(parseJsonArray('{"key": "value"}')).toEqual([]);
        expect(parseJsonArray('"string"')).toEqual([]);
        expect(parseJsonArray("42")).toEqual([]);
    });

    test("returns empty array for invalid JSON", () => {
        expect(parseJsonArray("not json")).toEqual([]);
        expect(parseJsonArray("{broken")).toEqual([]);
    });
});

// ── Dispatcher: global endpoints ────────────────────────────────────────────

describe("handleApi — global endpoints", () => {
    // Reset health state before each test so tests don't bleed into each other
    beforeEach(() => {
        serverHealth.redis = false;
        serverHealth.socketio = false;
    });

    test("GET /health returns degraded when redis/socketio are down", async () => {
        const url = new URL("http://localhost/health");
        const req = new Request(url, { method: "GET" });

        const res = await handleApi(req, url);
        expect(res).toBeTruthy();
        expect(res!.status).toBe(200);
        const data = await res!.json();
        expect(data.status).toBe("degraded");
        expect(data.redis).toBe(false);
        expect(data.socketio).toBe(false);
        expect(typeof data.uptime).toBe("number");
    });

    test("GET /health returns ok when redis and socketio are healthy", async () => {
        serverHealth.redis = true;
        serverHealth.socketio = true;

        const url = new URL("http://localhost/health");
        const req = new Request(url, { method: "GET" });

        const res = await handleApi(req, url);
        expect(res).toBeTruthy();
        expect(res!.status).toBe(200);
        const data = await res!.json();
        expect(data.status).toBe("ok");
        expect(data.redis).toBe(true);
        expect(data.socketio).toBe(true);
        expect(typeof data.uptime).toBe("number");
    });

    test("returns undefined for unmatched paths", async () => {
        const url = new URL("http://localhost/api/nonexistent");
        const req = new Request(url, { method: "GET" });

        const res = await handleApi(req, url);
        expect(res).toBeUndefined();
    });

    test("returns undefined for non-API paths", async () => {
        const url = new URL("http://localhost/some/random/path");
        const req = new Request(url, { method: "GET" });

        const res = await handleApi(req, url);
        expect(res).toBeUndefined();
    });
});

// ── Dispatcher: /api/hub-info ────────────────────────────────────────────────

describe("handleApi — /api/hub-info", () => {
    test("GET /api/hub-info returns 401 when not authenticated", async () => {
        // requireSession checks for a valid session cookie; without one it returns 401.
        const url = new URL("http://localhost/api/hub-info");
        const req = new Request(url, { method: "GET" });

        const res = await handleApi(req, url);
        expect(res).toBeTruthy();
        expect(res!.status).toBe(401);
    });
});

// ── Dispatcher: router delegation ───────────────────────────────────────────

describe("handleApi — router delegation", () => {
    test("sessions pin returns 405 for unsupported methods", async () => {
        const url = new URL("http://localhost/api/sessions/s-123/pin");
        const req = new Request(url, { method: "POST" });

        const res = await handleApi(req, url);
        expect(res).toBeTruthy();
        expect(res!.status).toBe(405);
        expect(res!.headers.get("Allow")).toBe("PUT, DELETE");
    });

    test("push vapid-public-key is accessible without auth", async () => {
        const url = new URL("http://localhost/api/push/vapid-public-key");
        const req = new Request(url, { method: "GET" });

        const res = await handleApi(req, url);
        expect(res).toBeTruthy();
        expect(res!.status).toBe(200);
        const data = await res!.json();
        expect(typeof data.publicKey).toBe("string");
    });

    // signup-status and register are tested via the E2E test in tests/api-e2e.test.ts
    // which sets up a real DB. Testing them here would require DB initialization.
});

// ── cwdMatchesRoots ─────────────────────────────────────────────────────────

describe("cwdMatchesRoots", () => {
    test("exact match", () => {
        expect(cwdMatchesRoots(["/home/user/projects"], "/home/user/projects")).toBe(true);
    });

    test("subdirectory match", () => {
        expect(cwdMatchesRoots(["/home/user/projects"], "/home/user/projects/app")).toBe(true);
        expect(cwdMatchesRoots(["/home/user/projects"], "/home/user/projects/app/src")).toBe(true);
    });

    test("rejects paths outside roots", () => {
        expect(cwdMatchesRoots(["/home/user/projects"], "/home/user/other")).toBe(false);
        expect(cwdMatchesRoots(["/home/user/projects"], "/etc/passwd")).toBe(false);
    });

    test("rejects prefix match that is not a directory boundary", () => {
        expect(cwdMatchesRoots(["/home/user/projects"], "/home/user/projects-evil")).toBe(false);
    });

    test("handles multiple roots", () => {
        const roots = ["/home/user/work", "/home/user/personal"];
        expect(cwdMatchesRoots(roots, "/home/user/work/app")).toBe(true);
        expect(cwdMatchesRoots(roots, "/home/user/personal/blog")).toBe(true);
        expect(cwdMatchesRoots(roots, "/tmp")).toBe(false);
    });

    test("handles trailing slashes in roots", () => {
        expect(cwdMatchesRoots(["/home/user/projects/"], "/home/user/projects/app")).toBe(true);
    });

    test("handles Windows paths", () => {
        expect(cwdMatchesRoots(["C:\\Users\\me\\code"], "C:\\Users\\me\\code\\app")).toBe(true);
        expect(cwdMatchesRoots(["C:\\Users\\me\\code"], "C:\\Users\\other")).toBe(false);
    });

    test("empty roots always returns false", () => {
        expect(cwdMatchesRoots([], "/any/path")).toBe(false);
    });
});
