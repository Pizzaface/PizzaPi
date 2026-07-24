import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// isolate storage under a temp HOME
const tmpHome = mkdtempSync(join(tmpdir(), "memtest-"));
process.env.HOME = tmpHome;
const cwd = mkdtempSync(join(tmpdir(), "memproj-"));

const S = await import("./storage.js");

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("projectKey is stable and sanitized", () => {
  const a = S.projectKey(cwd);
  const b = S.projectKey(cwd);
  expect(a).toBe(b);
  expect(a).toMatch(/^[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
});

test("save appends to index and reads back", () => {
  S.saveMemory({ summary: "use bun, not npm" }, cwd);
  S.saveMemory({ summary: "api handlers in src/api" }, cwd);
  const { text } = S.readIndexTruncated(cwd);
  expect(text).toContain("use bun, not npm");
  expect(text).toContain("api handlers in src/api");
});

test("detail writes a topic file and links it", () => {
  const r = S.saveMemory({ summary: "auth flow", detail: "JWT expiry is 15m", topic: "auth" }, cwd);
  expect(r.wroteTopic).toBe("auth.md");
  expect(S.readMemoryFile("auth", cwd)).toContain("JWT expiry is 15m");
  expect(S.readIndexRaw(cwd)).toContain("(see auth.md)");
});

test("index truncates at 200 lines", () => {
  const big = mkdtempSync(join(tmpdir(), "membig-"));
  for (let i = 0; i < 250; i++) S.saveMemory({ summary: `entry ${i}` }, big);
  const { text, truncated } = S.readIndexTruncated(big);
  expect(truncated).toBe(true);
  expect(text.split("\n").length).toBeLessThanOrEqual(S.MAX_INDEX_LINES);
  expect(S.capInfo(S.readIndexRaw(big)).overLimit).toBe(true);
  rmSync(big, { recursive: true, force: true });
});

test("edit requires unique match", () => {
  const e = mkdtempSync(join(tmpdir(), "memedit-"));
  S.saveMemory({ summary: "old fact" }, e);
  S.editFile("MEMORY.md", "old fact", "new fact", e);
  expect(S.readIndexRaw(e)).toContain("new fact");
  expect(() => S.editFile("MEMORY.md", "nope", "x", e)).toThrow();
  rmSync(e, { recursive: true, force: true });
});

test("topic name traversal is blocked", () => {
  S.appendTopic("../../evil", "x", cwd);
  const files = S.listFiles(cwd).map((f) => f.file);
  expect(files).toContain("evil.md");
  expect(files.every((f) => !f.includes("/"))).toBe(true);
});

test("recaps append and latest reads back", () => {
  S.appendRecap("you were building the storage module", cwd);
  S.appendRecap("you were wiring the MCP server", cwd);
  expect(S.latestRecap(cwd)).toBe("you were wiring the MCP server");
});
