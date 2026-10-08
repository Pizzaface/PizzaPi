import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ponytail: regex link scan, not a full MDX/remark AST walk — catches the
// real-world failure mode (a page deleted/renamed during docs consolidation
// leaves a dangling /PizzaPi/... link in a sibling page) without pulling in
// an MDX parser dependency.

const DOCS_ROOT = join(import.meta.dir, "src/content/docs");
const BASE = "/PizzaPi/";
const LINK_RE = /\]\(\/PizzaPi\/([^)\s#]*)[^)]*\)/g;

function listMdxFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...listMdxFiles(full));
        } else if (entry.endsWith(".mdx")) {
            out.push(full);
        }
    }
    return out;
}

function slugExists(slug: string): boolean {
    const clean = slug.replace(/\/$/, "");
    if (clean === "") return true; // index page
    const candidates = [join(DOCS_ROOT, `${clean}.mdx`), join(DOCS_ROOT, clean, "index.mdx")];
    return candidates.some((c) => {
        try {
            return statSync(c).isFile();
        } catch {
            return false;
        }
    });
}

describe("internal docs links", () => {
    const files = listMdxFiles(DOCS_ROOT);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
        const rel = relative(DOCS_ROOT, file);
        test(`${rel} only links to existing pages`, () => {
            const content = readFileSync(file, "utf8");
            const dangling: string[] = [];
            for (const match of content.matchAll(LINK_RE)) {
                const slug = match[1] ?? "";
                if (!slugExists(slug)) dangling.push(`${BASE}${slug}`);
            }
            expect(dangling).toEqual([]);
        });
    }
});
