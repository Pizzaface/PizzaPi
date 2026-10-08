import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ponytail: regex link scan, not a full MDX/remark AST walk — catches deleted
// pages/anchors in markdown links, frontmatter hero links, and Astro redirects
// without adding an MDX parser dependency.

const DOCS_ROOT = join(import.meta.dir, "src/content/docs");
const ASTRO_CONFIG = join(import.meta.dir, "astro.config.mjs");
const BASE = "/PizzaPi/";
const MARKDOWN_LINK_RE = /\]\((\/PizzaPi\/[^)\s]+)[^)]*\)/g;
const FRONTMATTER_LINK_RE = /^\s*(?:link|href|url):\s*["']?(\/PizzaPi\/[^"'\s]+)/gm;
const REDIRECT_RE = /["']\/[^"']*["']\s*:\s*["'](\/PizzaPi\/[^"']*)["']/g;

type InternalTarget = {
    source: string;
    target: string;
};

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

function slugPath(slug: string): string | null {
    const clean = slug.replace(/\/$/, "");
    if (clean === "") return null;
    const candidates = [join(DOCS_ROOT, `${clean}.mdx`), join(DOCS_ROOT, clean, "index.mdx")];
    return candidates.find((c) => {
        try {
            return statSync(c).isFile();
        } catch {
            return false;
        }
    }) ?? null;
}

function slugifyHeading(text: string): string {
    return text
        .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/[`*_~]/g, "")
        .trim()
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
        .replace(/\s/g, "-");
}

function anchorsFor(file: string): Set<string> {
    const anchors = new Set<string>();
    const seen = new Map<string, number>();
    for (const line of readFileSync(file, "utf8").split("\n")) {
        const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (!match) continue;
        const base = slugifyHeading(match[2] ?? "");
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    return anchors;
}

function splitTarget(target: string): { slug: string; anchor: string | null } {
    const withoutBase = target.slice(BASE.length);
    const [path = "", anchor = null] = withoutBase.split("#", 2);
    return { slug: path.replace(/\/$/, ""), anchor };
}

function extractFrontmatter(content: string): string {
    if (!content.startsWith("---\n")) return "";
    const end = content.indexOf("\n---", 4);
    return end === -1 ? "" : content.slice(4, end);
}

function extractMdxTargets(file: string): InternalTarget[] {
    const rel = relative(DOCS_ROOT, file);
    const content = readFileSync(file, "utf8");
    return [
        ...[...content.matchAll(MARKDOWN_LINK_RE)].map((match) => ({
            source: rel,
            target: match[1] ?? "",
        })),
        ...[...extractFrontmatter(content).matchAll(FRONTMATTER_LINK_RE)].map((match) => ({
            source: `${rel} frontmatter`,
            target: match[1] ?? "",
        })),
    ];
}

function extractRedirectTargets(): InternalTarget[] {
    const content = readFileSync(ASTRO_CONFIG, "utf8");
    return [...content.matchAll(REDIRECT_RE)].map((match) => ({
        source: "astro.config.mjs redirects",
        target: match[1] ?? "",
    }));
}

function danglingTargets(targets: InternalTarget[]): string[] {
    const dangling: string[] = [];
    const anchorCache = new Map<string, Set<string>>();
    for (const { source, target } of targets) {
        if (!target.startsWith(BASE)) continue;
        const { slug, anchor } = splitTarget(target);
        const file = slugPath(slug);
        if (!file) {
            dangling.push(`${source} -> ${target}`);
            continue;
        }
        if (anchor) {
            let anchors = anchorCache.get(file);
            if (!anchors) {
                anchors = anchorsFor(file);
                anchorCache.set(file, anchors);
            }
            if (!anchors.has(anchor)) dangling.push(`${source} -> ${target}`);
        }
    }
    return dangling;
}

describe("internal docs links", () => {
    const files = listMdxFiles(DOCS_ROOT);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
        const rel = relative(DOCS_ROOT, file);
        test(`${rel} only links to existing pages and anchors`, () => {
            expect(danglingTargets(extractMdxTargets(file))).toEqual([]);
        });
    }

    test("Astro redirects target existing pages and anchors", () => {
        expect(danglingTargets(extractRedirectTargets())).toEqual([]);
    });
});
