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

const { PresentedCard, PresentedCardGroup } = await import("./PresentedCard");

afterEach(() => cleanup());

const card: PresentedCardData = {
  kind: "business",
  title: "Bob's Handyman",
  subtitle: "Handyman",
  icon: "store",
  rating: { value: 4.5, max: 5, count: 12 },
  badges: ["$$"],
  fields: [{ label: "Phone", value: "555-1234" }],
  actions: [{ label: "Call", href: "tel:+15551234", icon: "phone" }],
};

describe("PresentedCard", () => {
  test("renders title, subtitle, fields, rating, and badges", () => {
    const { getByText, getByTitle } = render(<PresentedCard card={card} />);
    expect(getByText("Bob's Handyman")).toBeDefined();
    expect(getByText("Handyman")).toBeDefined();
    expect(getByText("Phone")).toBeDefined();
    expect(getByText("555-1234")).toBeDefined();
    expect(getByText("$$")).toBeDefined();
    expect(getByTitle("4.5 / 5")).toBeDefined();
  });

  test("renders actions as safe links", () => {
    const { getByText } = render(<PresentedCard card={card} />);
    const link = getByText("Call").closest("a") as HTMLAnchorElement | null;
    expect(link?.getAttribute("href")).toBe("tel:+15551234");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  test("a group of several shows a count header and every title", () => {
    const cards: PresentedCardData[] = [
      { kind: "business", title: "Alpha Co", icon: "store", badges: [], fields: [], actions: [] },
      { kind: "business", title: "Bravo Co", icon: "store", badges: [], fields: [], actions: [] },
      { kind: "business", title: "Charlie Co", icon: "store", badges: [], fields: [], actions: [] },
    ];
    const { getByText } = render(<PresentedCardGroup cards={cards} />);
    expect(getByText("3 results")).toBeDefined();
    expect(getByText("Alpha Co")).toBeDefined();
    expect(getByText("Bravo Co")).toBeDefined();
    expect(getByText("Charlie Co")).toBeDefined();
  });

  test("a group of one renders no count header", () => {
    const { queryByText, getByText } = render(<PresentedCardGroup cards={[card]} />);
    expect(getByText("Bob's Handyman")).toBeDefined();
    expect(queryByText(/results$/)).toBeNull();
  });
});
