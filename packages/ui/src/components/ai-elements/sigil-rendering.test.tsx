import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";

const win = new Window({ url: "http://localhost/" });
(win as unknown as { SyntaxError?: typeof SyntaxError }).SyntaxError = SyntaxError;
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = win.HTMLElement;
(globalThis as any).Element = win.Element;
(globalThis as any).Node = win.Node;
(globalThis as any).SVGElement = win.SVGElement;
(globalThis as any).MutationObserver = win.MutationObserver;
(globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);
(globalThis as any).SyntaxError = win.SyntaxError;
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as any).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};
/* eslint-enable @typescript-eslint/no-explicit-any */

import { MessageResponse } from "./message";

afterEach(() => {
  cleanup();
  win.document.body.innerHTML = "";
});

function renderSigilMarkdown(text: string) {
  return render(
    <MessageResponse mode="static" sigilCanInteract={true} sigilMessageComplete={true}>
      {text}
    </MessageResponse>,
  );
}

describe("sigil rendering pipeline", () => {
  test("action sigil with quoted params containing em-dashes/commas/pipes renders as buttons", async () => {
    const text =
      'Is the complaint the pill rendering itself (UI bug worth capturing — e.g. inline sigils breaking sentence flow/punctuation), or just my formatting? [[action:choose id=badwhat options="UI rendering bug — capture it|Just your formatting, fixed now|Something else"]]';
    renderSigilMarkdown(text);
    await waitFor(
      () => {
        expect(document.body.querySelector("button")).not.toBeNull();
        expect(document.body.textContent).toContain("UI rendering bug — capture it");
      },
      { timeout: 10000 },
    );
  });

  test("action sigil survives markdown emphasis (tildes) and commas inside parens", async () => {
    const text =
      '[[action:choose question="Scope for the new shift — 71 viable dishes is a lot" options="All 71 dishes,Security lane only (B-, 17 dishes),Top-band A dishes only (~60),Curated top ~20 across lanes"]]';
    renderSigilMarkdown(text);
    await waitFor(
      () => {
        const labels = Array.from(document.body.querySelectorAll("button")).map(
          (b) => b.textContent,
        );
        expect(labels).toContain("Security lane only (B-, 17 dishes)");
        expect(labels).toContain("Top-band A dishes only (~60)");
        expect(labels.length).toBe(4);
      },
      { timeout: 10000 },
    );
  });

  test("simple confirm action sigil with label renders as button", async () => {
    renderSigilMarkdown("Pick one [[action:confirm id=x label=Yes]]");
    await waitFor(
      () => {
        expect(document.body.querySelector("button")).not.toBeNull();
        expect(document.body.textContent).toContain("Yes");
      },
      { timeout: 10000 },
    );
  });

  test("adjacent action sigils coalesce into a wrapping flex row", async () => {
    renderSigilMarkdown(
      "[[action:choose id=a options=Yes|No]] [[action:choose id=b options=Maybe|Later]]",
    );
    await waitFor(
      () => {
        expect(document.body.innerHTML).toContain("flex flex-wrap");
        const buttons = document.body.querySelectorAll("button");
        expect(buttons.length).toBeGreaterThanOrEqual(4);
      },
      { timeout: 10000 },
    );
  });

  test("sigil pills use a generous max-width truncation class", async () => {
    renderSigilMarkdown('[[pr:123 label="fix(triggers): typed subscription handling"]]');
    await waitFor(
      () => {
        expect(document.body.innerHTML).toContain("max-w-[40ch]");
      },
      { timeout: 10000 },
    );
  });
});
