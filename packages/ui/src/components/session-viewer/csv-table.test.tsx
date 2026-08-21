/**
 * Tests for CsvTable — the TanStack-powered spreadsheet preview.
 */
import { afterEach, describe, test, expect } from "bun:test";
import { Window } from "happy-dom";
import { render, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = (win as any).HTMLElement;
(globalThis as any).Element = (win as any).Element;
(globalThis as any).Node = (win as any).Node;
(globalThis as any).getComputedStyle = (win as any).getComputedStyle;

const { CsvTable } = await import("./csv-table");

afterEach(() => cleanup());

const CSV = "Product,Qty,Total\nWidget,10,49.90\nGadget,3,149.95\nCable,25,37.25\n";

/** Data cell values for a given column index, in row order (skips spacer rows). */
function columnValues(container: HTMLElement, colIndex: number): string[] {
  return Array.from(container.querySelectorAll("tbody tr"))
    .map((tr) => Array.from(tr.querySelectorAll("td")))
    .filter((tds) => tds.length > colIndex)
    .map((tds) => tds[colIndex]?.textContent ?? "");
}

describe("CsvTable", () => {
  test("renders headers and cell values", () => {
    const { getByText } = render(<CsvTable content={CSV} />);
    expect(getByText("Product")).toBeDefined();
    expect(getByText("Total")).toBeDefined();
    expect(getByText("Widget")).toBeDefined();
    expect(getByText("149.95")).toBeDefined();
  });

  test("empty content shows an empty state", () => {
    const { getByText } = render(<CsvTable content="" />);
    expect(getByText(/empty file/i)).toBeDefined();
  });

  test("clicking a numeric header sorts by value ascending then descending", () => {
    const { getByText, container } = render(<CsvTable content={CSV} />);
    // Baseline order (as parsed): Total column = 49.90, 149.95, 37.25
    expect(columnValues(container, 2)).toEqual(["49.90", "149.95", "37.25"]);

    fireEvent.click(getByText("Total"));
    // Ascending numeric — not lexicographic (149.95 would sort before 37.25 as text).
    expect(columnValues(container, 2)).toEqual(["37.25", "49.90", "149.95"]);

    fireEvent.click(getByText("Total"));
    expect(columnValues(container, 2)).toEqual(["149.95", "49.90", "37.25"]);
  });

  test("clicking a text header sorts alphabetically", () => {
    const { getByText, container } = render(<CsvTable content={CSV} />);
    fireEvent.click(getByText("Product"));
    expect(columnValues(container, 0)).toEqual(["Cable", "Gadget", "Widget"]);
  });

  test("sortable headers are focusable and support Enter and Space", () => {
    const { getByRole, container } = render(<CsvTable content={CSV} />);
    const total = getByRole("button", { name: "Total" });

    total.focus();
    expect(document.activeElement).toBe(total);

    fireEvent.keyDown(total, { key: "Enter" });
    expect(columnValues(container, 2)).toEqual(["37.25", "49.90", "149.95"]);

    fireEvent.keyDown(total, { key: " " });
    expect(columnValues(container, 2)).toEqual(["149.95", "49.90", "37.25"]);
  });

  test("headers expose their sort state", () => {
    const { getByRole } = render(<CsvTable content={CSV} />);
    const product = getByRole("columnheader", { name: "Product" });
    const total = getByRole("columnheader", { name: "Total" });

    expect(product.getAttribute("aria-sort")).toBe("none");
    expect(total.getAttribute("aria-sort")).toBe("none");

    fireEvent.click(getByRole("button", { name: "Total" }));
    expect(total.getAttribute("aria-sort")).toBe("ascending");
    expect(product.getAttribute("aria-sort")).toBe("none");

    fireEvent.click(getByRole("button", { name: "Total" }));
    expect(total.getAttribute("aria-sort")).toBe("descending");
  });
});
