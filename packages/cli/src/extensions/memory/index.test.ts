import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "memext-home-"));
const projDir = mkdtempSync(join(tmpdir(), "memext-proj-"));
process.env.HOME = tmpHome;
process.env.PIZZAPI_PROJECT_DIR = projDir;

const { memoryExtension } = await import("./index.js");

// Minimal fake `pi` capturing registrations.
function makeFakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const sent: any[] = [];
  const userMessages: string[] = [];
  const pi: any = {
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    on: (evt: string, h: Function) => {
      const list = handlers.get(evt) ?? [];
      list.push(h);
      handlers.set(evt, list);
    },
    sendMessage: (m: any) => sent.push(m),
    sendUserMessage: (c: string) => userMessages.push(c),
    getSessionName: () => undefined,
    setSessionName: () => {},
  };
  return { pi, tools, commands, handlers, sent, userMessages };
}

let fake: ReturnType<typeof makeFakePi>;
beforeAll(() => {
  fake = makeFakePi();
  memoryExtension(fake.pi);
});
afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

test("registers all memory tools + recap", () => {
  for (const n of ["memory_save", "memory_append", "memory_edit", "memory_read", "memory_list", "recap"]) {
    expect(fake.tools.has(n)).toBe(true);
  }
});

test("registers /memory and /recap commands", () => {
  expect(fake.commands.has("memory")).toBe(true);
  expect(fake.commands.has("recap")).toBe(true);
});

test("memory_save persists and memory_list reads it back", async () => {
  await fake.tools.get("memory_save").execute("id1", { summary: "use bun not npm" });
  const res = await fake.tools.get("memory_list").execute("id2", {});
  const payload = JSON.parse(res.content[0].text);
  expect(payload.index).toContain("use bun not npm");
});

test("before_agent_start injects the memory block + save instruction", async () => {
  const handler = fake.handlers.get("before_agent_start")![0];
  const result = await handler({ systemPrompt: "BASE" });
  expect(result.systemPrompt).toContain("BASE");
  expect(result.systemPrompt).toContain("<project-memory>");
  expect(result.systemPrompt).toContain("use bun not npm");
  expect(result.systemPrompt).toContain("memory_save");
});

test("resume surfaces the latest recap once", async () => {
  await fake.tools.get("recap").execute("id3", { summary: "you were wiring the memory extension" });
  const startHandlers = fake.handlers.get("session_start")!;
  for (const h of startHandlers) await h({ reason: "resume" });
  const recap = fake.sent.find((m) => m.customType === "memory_recap");
  expect(recap).toBeTruthy();
  expect(recap.content).toContain("you were wiring the memory extension");
});

test("/recap (no args) requests a fresh summary from the model", async () => {
  await fake.commands.get("recap").handler("", {});
  expect(fake.userMessages.some((m) => m.includes("recap"))).toBe(true);
});
