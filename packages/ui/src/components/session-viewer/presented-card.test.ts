import { describe, test, expect } from "bun:test";
import { detectPresentedCard, isSafeActionHref } from "./presented-card";

describe("isSafeActionHref", () => {
  test("allows tel/mailto/sms/geo/http(s)", () => {
    for (const href of ["tel:+15551234567", "mailto:a@b.com", "sms:+1555", "geo:37.1,-122.1", "https://x.com", "http://x.com/p"]) {
      expect(isSafeActionHref(href)).toBe(true);
    }
  });
  test("rejects javascript/data/file and empty", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "  "]) {
      expect(isSafeActionHref(href)).toBe(false);
    }
  });
});

describe("detectPresentedCard", () => {
  test("ignores non-present tools", () => {
    expect(detectPresentedCard("bash", { title: "x" })).toBeNull();
    expect(detectPresentedCard("write", { title: "x" })).toBeNull();
  });

  test("requires a title", () => {
    expect(detectPresentedCard("present_card", { subtitle: "no title" })).toBeNull();
    expect(detectPresentedCard("present_card", { title: "   " })).toBeNull();
  });

  test("builds a card with fields and safe actions", () => {
    const card = detectPresentedCard("present_card", {
      title: "Bob's Handyman",
      subtitle: "Handyman",
      icon: "wrench",
      fields: [
        { label: "Phone", value: "555-1234" },
        { label: "Tags", value: ["licensed", "insured"] },
        { label: "", value: "" },
      ],
      actions: [
        { label: "Call", href: "tel:+15551234", icon: "phone" },
        { label: "Evil", href: "javascript:alert(1)" },
      ],
    });
    expect(card?.title).toBe("Bob's Handyman");
    expect(card?.subtitle).toBe("Handyman");
    expect(card?.fields).toEqual([
      { label: "Phone", value: "555-1234" },
      { label: "Tags", value: "licensed, insured" },
    ]);
    expect(card?.actions).toEqual([{ label: "Call", href: "tel:+15551234", icon: "phone" }]);
  });

  test("only accepts http(s) images", () => {
    expect(detectPresentedCard("present_card", { title: "x", image: "https://y/a.png" })?.image).toBe("https://y/a.png");
    expect(detectPresentedCard("present_card", { title: "x", image: "javascript:1" })?.image).toBeUndefined();
  });

  test("recognizes the MCP-prefixed form and JSON-string input", () => {
    expect(detectPresentedCard("mcp__pizzawork__present_card", { title: "Prefixed" })?.title).toBe("Prefixed");
    expect(detectPresentedCard("present_card", JSON.stringify({ title: "Stringy" }))?.title).toBe("Stringy");
  });
});
