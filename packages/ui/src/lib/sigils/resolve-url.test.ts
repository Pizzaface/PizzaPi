import { describe, expect, test } from "bun:test";
import { buildResolveUrl } from "./resolve-url.js";

describe("buildResolveUrl", () => {
    test("bare path, no params or cwd", () => {
        expect(
            buildResolveUrl({ runnerId: "r1", port: 56500, resolvePath: "/api/resolve/pr/853" }),
        ).toBe("/api/tunnel/runner/r1/56500/api/resolve/pr/853");
    });

    test("sessionCwd is appended as query param", () => {
        const url = buildResolveUrl({
            runnerId: "r1",
            port: 56500,
            resolvePath: "/api/resolve/pr/853",
            sessionCwd: "/Users/jordan/Documents/Projects/PizzaPi",
        });
        expect(url).toBe(
            "/api/tunnel/runner/r1/56500/api/resolve/pr/853?cwd=%2FUsers%2Fjordan%2FDocuments%2FProjects%2FPizzaPi",
        );
    });

    test("inline params pass through except filtered keys", () => {
        const url = buildResolveUrl({
            runnerId: "r1",
            port: 56500,
            resolvePath: "/api/resolve/pr/853",
            params: { repo: "Pizzaface/PizzaPi", label: "hidden", link: "hidden", href: "hidden" },
        });
        expect(url).toBe("/api/tunnel/runner/r1/56500/api/resolve/pr/853?repo=Pizzaface%2FPizzaPi");
    });

    test("inline cwd param is overridden by sessionCwd", () => {
        const url = buildResolveUrl({
            runnerId: "r1",
            port: 56500,
            resolvePath: "/api/resolve/pr/1",
            params: { cwd: "/fake/inline" },
            sessionCwd: "/real/session",
        });
        expect(url).toContain("cwd=%2Freal%2Fsession");
        expect(url).not.toContain("fake");
    });

    test("runnerId is URL-encoded", () => {
        const url = buildResolveUrl({ runnerId: "a b/c", port: 1, resolvePath: "/x" });
        expect(url).toBe("/api/tunnel/runner/a%20b%2Fc/1/x");
    });
});