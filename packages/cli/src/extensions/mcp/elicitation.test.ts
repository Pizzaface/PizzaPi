import { describe, expect, test } from "bun:test";
import type { ApprovalRequest, ApprovalDecision } from "@pizzapi/protocol";
import { elicitForm, createElicitationHandler } from "./elicitation.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const params = {
  message: "Contact information",
  requestedSchema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 2 },
      age: { type: "integer", minimum: 18, default: 20 },
      email: { type: "string", format: "email" },
      enabled: { type: "boolean", default: false },
      colors: { type: "array", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "red", title: "Red" }, { const: "blue", title: "Blue" }] } },
    },
    required: ["name"],
  },
};

describe("MCP form elicitation", () => {
  test("TUI can edit, review, and explicitly accept; headless mode has no handler", async () => {
    expect(createElicitationHandler("s")).toBeUndefined();
    const selections = ["Edit responses", "Change", "Accept"];
    const titles: string[] = [];
    const ctx = {
      hasUI: true, mode: "tui",
      ui: {
        select: async (title: string) => { titles.push(title); return selections.shift(); },
        input: async () => "Alice",
      },
    } as unknown as ExtensionContext;
    const handler = createElicitationHandler("contacts", ctx)!;
    expect(await handler({ message: "Name?", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } })).toEqual({ action: "accept", content: { name: "Alice" } });
    expect(titles.at(-1)).toContain("Alice");
    expect(titles.every(title => title.includes("contacts"))).toBe(true);
  });

  test("attributes server, shows defaults and choices, validates then resubmits only schema fields", async () => {
    const prompts: ApprovalRequest[] = [];
    const result = await elicitForm("contacts", params, async (request): Promise<ApprovalDecision> => {
      prompts.push(structuredClone(request));
      return prompts.length === 1
        ? { action: "approve", approved: true, edits: { name: "A", age: "17", email: "invalid", colors: '["red"]' } }
        : { action: "approve", approved: true, edits: { name: "Alice", age: "25", email: "alice@example.com", ignored: "no" } };
    });
    expect(result).toEqual({ action: "accept", content: { name: "Alice", age: 25, email: "alice@example.com", enabled: false, colors: ["red"] } });
    expect(prompts[0].title).toContain("contacts");
    expect(prompts[0].message).toBeUndefined(); // Server text must not render clickable Markdown.
    expect(prompts[0].fields?.find(f => f.key === "age")?.value).toBe("20");
    expect(prompts[0].fields?.find(f => f.key === "colors")?.label).toContain("Red");
    expect(prompts[1].fields?.some(f => f.label === "Validation error")).toBe(true);
    expect(prompts[0].actions?.map(a => a.label)).toEqual(["Accept", "Decline", "Cancel"]);
  });

  test.each(["decline", "cancel", "reject", "unavailable"])("%s never includes form content", async (action) => {
    expect(await elicitForm("s", params, async () => ({ action, approved: false }))).toEqual({ action: action === "decline" ? "decline" : "cancel" });
  });

  test("rejects URL mode and unsupported schema without opening a prompt", async () => {
    const prompt = async (): Promise<ApprovalDecision> => { throw new Error("must not prompt"); };
    await expect(elicitForm("s", { mode: "url", url: "https://example.com" }, prompt)).rejects.toThrow("form");
    await expect(elicitForm("s", { ...params, requestedSchema: { type: "object", properties: { secret: { type: "object" } } } }, prompt)).rejects.toThrow();
    await expect(elicitForm("s", { ...params, requestedSchema: { type: "object", properties: { x: { type: "string", pattern: "evil" } } } }, prompt)).rejects.toThrow("Unsupported");
  });

  test("aborted calls never prompt or accept", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(elicitForm("s", params, async () => { throw new Error("prompted"); }, ac.signal)).rejects.toThrow();
    const during = new AbortController();
    await expect(elicitForm("s", params, async () => {
      during.abort();
      return { action: "approve", approved: true, edits: { name: "Alice" } };
    }, during.signal)).rejects.toThrow();
  });

  test.each([
    [{ type: "string", format: "date" }, "2026-02-30"],
    [{ type: "string", format: "date-time" }, "yesterday"],
    [{ type: "string", format: "uri" }, "no uri"],
    [{ type: "number", maximum: 10 }, "11"],
    [{ type: "integer" }, "1.5"],
    [{ type: "boolean" }, "yes"],
    [{ type: "string", enum: ["red"] }, "blue"],
    [{ type: "string", oneOf: [{ const: "red", title: "Red" }] }, "blue"],
    [{ type: "array", items: { type: "string", enum: ["red"] } }, '["blue"]'],
  ])("invalid field %j stays local", async (schema, value) => {
    let attempts = 0;
    const result = await elicitForm("s", { message: "Input", requestedSchema: { type: "object", properties: { x: schema }, required: ["x"] } }, async (request) => {
      if (attempts++ === 0) return { action: "approve", approved: true, edits: { x: value as string } };
      expect(request.fields?.some(f => f.label === "Validation error")).toBe(true);
      return { action: "cancel", approved: false };
    });
    expect(result).toEqual({ action: "cancel" });
    expect(attempts).toBe(2);
  });
});
