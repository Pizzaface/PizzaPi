/**
 * Tests for PresentedCard — the read-only entity card.
 */
import { afterEach, describe, test, expect } from "bun:test";
import { Window } from "happy-dom";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import type { PresentedCard as PresentedCardData } from "./presented-card";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = (win as any).HTMLElement;
(globalThis as any).Element = (win as any).Element;
(globalThis as any).Node = (win as any).Node;
(globalThis as any).getComputedStyle = (win as any).getComputedStyle;

const { PresentedCard } = await import("./PresentedCard");

afterEach(() => cleanup());

const card: PresentedCardData = {
  title: "Bob's Handyman",
  subtitle: "Handyman",
  icon: "wrench",
  fields: [{ label: "Phone", value: "555-1234" }],
  actions: [{ label: "Call", href: "tel:+15551234", icon: "phone" }],
};

describe("PresentedCard", () => {
  test("renders title, subtitle, fields", () => {
    const { getByText } = render(<PresentedCard card={card} />);
    expect(getByText("Bob's Handyman")).toBeDefined();
    expect(getByText("Handyman")).toBeDefined();
    expect(getByText("Phone")).toBeDefined();
    expect(getByText("555-1234")).toBeDefined();
  });

  test("renders actions as safe links", () => {
    const { getByText } = render(<PresentedCard card={card} />);
    const link = getByText("Call").closest("a") as HTMLAnchorElement | null;
    expect(link?.getAttribute("href")).toBe("tel:+15551234");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });
});
