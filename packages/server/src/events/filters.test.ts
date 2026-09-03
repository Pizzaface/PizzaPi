import { describe, expect, it } from "bun:test";
import { payloadMatchesFilters } from "./engine.js";

describe("payloadMatchesFilters eq", () => {
  it("string eq is case-insensitive (GitHub login casing must not drop events)", () => {
    expect(payloadMatchesFilters({ author: "Pizzaface" }, [{ field: "author", value: "pizzaface" }])).toBe(true);
    expect(payloadMatchesFilters({ author: "Pizzaface" }, [{ field: "author", value: "someone" }])).toBe(false);
  });
  it("non-string eq stays loose (number/string, booleans)", () => {
    expect(payloadMatchesFilters({ prNumber: 865 }, [{ field: "prNumber", value: "865" }])).toBe(true);
    expect(payloadMatchesFilters({ draft: false }, [{ field: "draft", value: false }])).toBe(true);
    expect(payloadMatchesFilters({ draft: false }, [{ field: "draft", value: true }])).toBe(false);
  });
});
