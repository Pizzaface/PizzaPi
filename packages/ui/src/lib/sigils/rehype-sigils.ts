/**
 * Rehype plugin that transforms [[type:id params]] tokens in text nodes
 * into <sigil> elements for Streamdown's component renderer.
 *
 * Skips text inside <code> and <pre> elements (code blocks/spans).
 * No external dependencies — walks the hast tree manually.
 */
import { parseSigils } from "./parser";

// ── Minimal hast types (avoids @types/hast dependency) ───────────────────────

interface HastText {
  type: "text";
  value: string;
}

interface HastElement {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNode[];
}

interface HastRoot {
  type: "root";
  children: HastNode[];
}

type HastNode = HastText | HastElement | HastRoot | { type: string; [key: string]: unknown };

// ── Code-ancestor detection ──────────────────────────────────────────────────

const CODE_TAGS = new Set(["code", "pre"]);

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

function isSigilSpan(node: HastNode): boolean {
  return isElement(node) && Boolean(node.properties?.["data-sigil-type"]);
}

// ── Source reconstruction ────────────────────────────────────────────────────

/**
 * Markdown delimiters for inline elements. Sigil params routinely contain
 * characters markdown treats as emphasis (`~60`, `*`, `_`), which splits one
 * `[[...]]` token across several inline nodes. We rebuild the original source
 * text so the parser sees the whole token again.
 */
const INLINE_DELIM: Record<string, string> = {
  em: "*",
  strong: "**",
  del: "~",
  s: "~",
  sub: "~",
};

/** Opaque placeholder for children we cannot reconstruct (images, links, …). */
const OPAQUE = "\u0000";

function sourceText(node: HastNode): string {
  if (node.type === "text") return (node as HastText).value;
  if (!isElement(node)) return OPAQUE;
  const delim = INLINE_DELIM[node.tagName];
  if (delim === undefined) return OPAQUE;
  return delim + node.children.map(sourceText).join("") + delim;
}

// ── Sigil span builder ───────────────────────────────────────────────────────

function buildSigilSpan(match: import("./types").SigilMatch): HastElement {
  const properties: Record<string, unknown> = {
    "data-sigil-type": match.type,
    "data-sigil-id": match.id,
    "data-sigil-raw": match.raw,
  };
  if (Object.keys(match.params).length > 0) {
    properties["data-sigil-params"] = JSON.stringify(match.params);
  }
  return { type: "element", tagName: "span", properties, children: [] };
}

// ── Coalescing ───────────────────────────────────────────────────────────────

/**
 * Group consecutive sigil nodes (with only whitespace between them)
 * into a single wrapper span with data-sigil-group="true".
 */
function coalesceNodes(nodes: HastNode[]): HastNode[] {
  const result: HastNode[] = [];
  let group: HastElement[] = [];

  function flushGroup() {
    if (group.length === 0) return;
    if (group.length === 1) {
      result.push(group[0]);
    } else {
      result.push({
        type: "element",
        tagName: "span",
        properties: { "data-sigil-group": "true" },
        children: group as HastNode[],
      });
    }
    group = [];
  }

  for (const node of nodes) {
    const isSigil = isSigilSpan(node);

    const isWhitespaceOnly =
      node.type === "text" && /^\s+$/.test((node as HastText).value);

    if (isSigil) {
      group.push(node as HastElement);
    } else if (isWhitespaceOnly && group.length > 0) {
      // Whitespace between sigils — absorb into group, will be rendered as gap
      continue;
    } else {
      flushGroup();
      result.push(node);
    }
  }

  flushGroup();
  return result;
}

// ── Per-parent transform ─────────────────────────────────────────────────────

/**
 * Replace sigil tokens found across this parent's children (a token may span
 * several inline nodes once markdown has split it) with sigil spans.
 */
function transformChildren(parent: HastElement | HastRoot): void {
  const children = parent.children;
  const segments = children.map(sourceText);
  const joined = segments.join("");
  if (!joined.includes("[[")) return;

  const matches = parseSigils(joined);
  if (matches.length === 0) return;

  // Offset of each child within `joined`.
  const starts: number[] = [];
  let offset = 0;
  for (const seg of segments) {
    starts.push(offset);
    offset += seg.length;
  }
  const childAt = (pos: number): number => {
    let index = 0;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] <= pos) index = i;
      else break;
    }
    return index;
  };

  const out: HastNode[] = [];
  let cursor = 0; // index into `joined` of the next unconsumed character
  let childIndex = 0; // next child not yet emitted

  for (const match of matches) {
    if (match.start < cursor) continue;
    const first = childAt(match.start);
    const last = childAt(match.end - 1);
    // Both edges must land in text nodes so we can slice cleanly.
    if (children[first].type !== "text" || children[last].type !== "text") continue;

    // Emit untouched children before the match.
    for (; childIndex < first; childIndex++) out.push(children[childIndex]);

    const head = (children[first] as HastText).value.slice(0, match.start - starts[first]);
    if (head) out.push({ type: "text", value: head });
    out.push(buildSigilSpan(match));

    const tailStart = match.end - starts[last];
    const tail = (children[last] as HastText).value.slice(tailStart);
    children[last] = { type: "text", value: tail };
    starts[last] = match.end;
    childIndex = last;
    cursor = match.end;
  }

  for (; childIndex < children.length; childIndex++) {
    const child = children[childIndex];
    if (child.type === "text" && (child as HastText).value === "") continue;
    out.push(child);
  }

  parent.children = coalesceNodes(out);
}

// ── Plugin ───────────────────────────────────────────────────────────────────

function transform(node: HastNode): void {
  if (!("children" in node) || !Array.isArray(node.children)) return;
  if (isElement(node) && CODE_TAGS.has(node.tagName)) return;

  transformChildren(node as HastElement | HastRoot);

  for (const child of (node as HastElement).children) {
    if (isElement(child) && !isSigilSpan(child)) transform(child);
  }
}

/**
 * Rehype plugin factory. Returns a transformer that replaces sigil tokens
 * with <span> elements, coalescing adjacent sigils into groups.
 */
export function rehypeSigils() {
  return (tree: HastRoot) => transform(tree);
}
