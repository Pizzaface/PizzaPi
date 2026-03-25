import { describe, expect, test } from "bun:test";
import { buildPizzapiTitle } from "./pizzapi-title.js";

describe("buildPizzapiTitle", () => {
    test("includes session name when provided", () => {
        const title = buildPizzapiTitle("Fix login bug", "/Users/jordan/Projects/MyApp");
        expect(title).toBe("🍕 PizzaPi — Fix login bug — MyApp");
    });

    test("omits session name when undefined", () => {
        const title = buildPizzapiTitle(undefined, "/Users/jordan/Projects/MyApp");
        expect(title).toBe("🍕 PizzaPi — MyApp");
    });

    test("uses basename of cwd", () => {
        const title = buildPizzapiTitle(undefined, "/home/user/deep/nested/path");
        expect(title).toBe("🍕 PizzaPi — path");
    });

    test("handles root cwd", () => {
        const title = buildPizzapiTitle(undefined, "/");
        // basename("/") === "" on POSIX
        expect(title).toBe("🍕 PizzaPi — ");
    });

    test("uses em-dash separator (—)", () => {
        const title = buildPizzapiTitle("My Session", "/tmp/work");
        expect(title).toContain("—");
        expect(title).toMatch(/^🍕 PizzaPi — .+ — .+$/);
    });
});
