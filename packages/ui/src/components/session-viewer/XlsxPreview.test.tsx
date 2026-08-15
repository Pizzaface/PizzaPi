/**
 * Tests for XlsxPreview — round-trips a SheetJS workbook through the viewer.
 */
import { afterEach, describe, test, expect } from "bun:test";
import { Window } from "happy-dom";
import { render, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import * as XLSX from "xlsx";

const win = new Window({ url: "http://localhost/" });
(win as any).SyntaxError = globalThis.SyntaxError;
(globalThis as any).window = win;
(globalThis as any).document = win.document;
(globalThis as any).navigator = win.navigator;
(globalThis as any).HTMLElement = (win as any).HTMLElement;
(globalThis as any).Element = (win as any).Element;
(globalThis as any).Node = (win as any).Node;
(globalThis as any).getComputedStyle = (win as any).getComputedStyle;

const { default: XlsxPreview } = await import("./XlsxPreview");

afterEach(() => cleanup());

/** Build a base64 .xlsx from sheets of arrays-of-arrays. */
function workbookBase64(sheets: Record<string, unknown[][]>): string {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}

describe("XlsxPreview", () => {
  test("renders the first sheet's header and cells", () => {
    const b64 = workbookBase64({
      Sales: [
        ["Product", "Qty", "Total"],
        ["Widget", 10, 49.9],
        ["Gadget", 3, 149.95],
      ],
    });
    const { getByText } = render(<XlsxPreview content={b64} />);
    expect(getByText("Product")).toBeDefined();
    expect(getByText("Total")).toBeDefined();
    expect(getByText("Widget")).toBeDefined();
    expect(getByText("149.95")).toBeDefined();
  });

  test("shows a tab per sheet and switches sheets on click", () => {
    const b64 = workbookBase64({
      Sales: [["A"], ["one"]],
      Summary: [["B"], ["two"]],
    });
    const { getByText, queryByText } = render(<XlsxPreview content={b64} />);
    // First sheet visible.
    expect(getByText("one")).toBeDefined();
    expect(queryByText("two")).toBeNull();
    // Switch to the second sheet.
    fireEvent.click(getByText("Summary"));
    expect(getByText("two")).toBeDefined();
    expect(queryByText("one")).toBeNull();
  });

  test("bad content renders without throwing", () => {
    // SheetJS is lenient — it coerces arbitrary bytes into a workbook rather
    // than throwing. The contract we care about is that the viewer never
    // crashes on junk input; it renders whatever fell out.
    const { container } = render(<XlsxPreview content="not-a-real-xlsx" />);
    expect(container.textContent).toBeTruthy();
  });
});
