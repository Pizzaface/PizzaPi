import { describe, expect, test } from "bun:test";
import type { ApprovalRequest, ApprovalDecision } from "@pizzapi/protocol";
import { elicitForm, elicitUrl, createElicitationHandler, validateElicitationUrl } from "./elicitation.js";
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

  test("rejects non-form modes and unsupported schema without opening a prompt", async () => {
    const prompt = async (): Promise<ApprovalDecision> => { throw new Error("must not prompt"); };
    await expect(elicitForm("s", { mode: "url", url: "https://example.com" }, prompt)).rejects.toThrow("unsupported");
    await expect(elicitForm("s", { mode: "voice", url: "https://example.com" }, prompt)).rejects.toThrow("unsupported");
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

describe("MCP URL elicitation", () => {
  const url = "https://mcp.example.com/ui/set_api_key?flow=abc";
  const params = { mode: "url", url, message: "Provide your API key on our site." };
  const never = async (): Promise<ApprovalDecision> => { throw new Error("must not prompt"); };

  test.each([
    ["http://evil.example.com/x", "https"],
    ["javascript:alert(1)", "https"],
    ["data:text/html,hi", "https"],
    ["file:///etc/passwd", "https"],
    ["ftp://example.com/x", "https"],
    ["https://user:pw@example.com/x", "credentials"],
    ["https://user@example.com/x", "credentials"],
    ["https://example.com/x y", "control"],
    ["https://example.com/x\u0000y", "control"],
    ["https://example.com/x\u202ey", "bidi"],
    ["https://example.com\\evil.com/x", "backslash"],
    ["https://example.com/\u200bx", "bidi"],
    ["example.com/no-scheme", "absolute"],
    ["", "requires"],
    [`https://example.com/${"a".repeat(9000)}`, "8192"],
  ])("rejects %s without prompting", async (bad, reason) => {
    expect(() => validateElicitationUrl(bad)).toThrow(reason);
    await expect(elicitUrl("s", { ...params, url: bad }, never, undefined, new Set())).rejects.toThrow();
  });

  test("allows https and localhost http; warns on http and punycode", () => {
    expect(validateElicitationUrl("http://localhost:3000/cb").warnings.join()).toContain("http");
    expect(validateElicitationUrl("http://127.0.0.1/cb").warnings).toHaveLength(1);
    expect(validateElicitationUrl("http://[::1]:8080/cb").warnings).toHaveLength(1);
    expect(validateElicitationUrl("http://app.localhost/cb").warnings).toHaveLength(1);
    expect(validateElicitationUrl(url).warnings).toEqual([]);
    const punycode = validateElicitationUrl("https://аpple.com/login"); // Cyrillic а
    expect(punycode.url.hostname).toStartWith("xn--");
    expect(punycode.warnings.join()).toContain("Punycode");
  });

  test("shows server, inert message, host and full URL; only the offered link action consents; accept has no content", async () => {
    const prompts: ApprovalRequest[] = [];
    const consented = new Set<string>();
    const result = await elicitUrl("payments", { ...params, message: "See https://phish.example" }, async request => {
      prompts.push(structuredClone(request));
      return { action: "open", approved: false };
    }, undefined, consented);
    expect(result).toEqual({ action: "accept" });
    expect(consented.has(url)).toBe(true);
    const [request] = prompts;
    expect(request.title).toBe("MCP server: payments");
    expect(request.message).toBeUndefined(); // server text never renders as Markdown
    const value = (key: string) => request.fields?.find(f => f.key === key)?.value;
    expect(value("mcp:host")).toBe("mcp.example.com");
    expect(value("mcp:url")).toBe(url);
    expect(value("mcp:message")).toBe("See https://phish.example");
    expect(request.fields?.every(f => !f.editable)).toBe(true);
    // The only navigable thing is the url param, and it is the consent action.
    expect(request.actions).toEqual([
      { id: "open", label: "Open in browser", style: "primary", href: url },
      { id: "decline", label: "Decline", style: "danger" },
      { id: "cancel", label: "Cancel" },
    ]);
  });

  test("a generic approve is not consent on the first card", async () => {
    const consented = new Set<string>();
    expect(await elicitUrl("s", params, async () => ({ action: "approve", approved: true }), undefined, consented)).toEqual({ action: "cancel" });
    expect(consented.size).toBe(0);
  });

  test.each(["decline", "cancel", "reject", "unavailable"])("%s never consents", async action => {
    const consented = new Set<string>();
    expect(await elicitUrl("s", params, async () => ({ action, approved: false }), undefined, consented)).toEqual({ action: action === "decline" ? "decline" : "cancel" });
    expect(consented.size).toBe(0);
  });

  test("a repeated URL offers Retry / Open again instead of silently re-consenting", async () => {
    const consented = new Set([url]);
    const prompts: ApprovalRequest[] = [];
    const answer = async (request: ApprovalRequest): Promise<ApprovalDecision> => { prompts.push(request); return { action: "approve", approved: true }; };
    expect(await elicitUrl("s", params, answer, undefined, consented)).toEqual({ action: "accept" });
    expect(prompts[0].actions?.map(a => a.id)).toEqual(["approve", "open", "decline", "cancel"]);
    expect(prompts[0].actions?.filter(a => a.href).map(a => a.id)).toEqual(["open"]);
    expect(prompts[0].fields?.[0].label).toBe("Status");
    expect(await elicitUrl("s", params, async () => ({ action: "cancel", approved: false }), undefined, consented)).toEqual({ action: "cancel" });
  });

  test("aborted calls never prompt", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(elicitUrl("s", params, never, ac.signal, new Set())).rejects.toThrow();
  });

  test("handler routes url mode, exposes manual resume, and TUI never opens links", async () => {
    const seen: string[] = [];
    const picks = ["Open in browser (I opened the URL myself)", "Retry", "Cancel"];
    const ctx = { hasUI: true, mode: "tui", ui: { select: async (title: string, options: string[]) => { seen.push(title, options.join("|")); return picks.shift(); }, input: async () => undefined } } as unknown as ExtensionContext;
    const handler = createElicitationHandler("s", ctx)!;
    expect(await handler(params)).toEqual({ action: "accept" });
    expect(seen[0]).toContain(url);
    expect(seen[0]).toContain("will not open links");
    expect(seen[1]).not.toContain("Edit responses");
    expect(await handler.resume!()).toBe("retry");
    expect(await handler.resume!()).toBe("cancel");
    expect(seen.at(-2)).toContain("Waiting");
    // Headless: no handler at all, so no capability and no auto-consent.
    expect(createElicitationHandler("s")).toBeUndefined();
  });
});
