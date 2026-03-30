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

function hasCodeAncestor(ancestors: HastNode[]): boolean {
  return ancestors.some((n) => isElement(n) && CODE_TAGS.has(n.tagName));
}

// ── Tree walker ──────────────────────────────────────────────────────────────

/**
 * Walk a hast tree depth-first, calling `fn` on every text node
 * with its list of ancestors. `fn` can return replacement nodes.
 */
function walkText(
  node: HastNode,
  ancestors: HastNode[],
  fn: (text: HastText, ancestors: HastNode[]) => HastNode[] | null,
): void {
  if (!("children" in node) || !Array.isArray(node.children)) return;

  const parent = node as HastElement | HastRoot;
  const newChildren: HastNode[] = [];
  let changed = false;

  for (const child of parent.children) {
    if (child.type === "text") {
      const replacement = fn(child as HastText, ancestors);
      if (replacement) {
        newChildren.push(...replacement);
        changed = true;
      } else {
        newChildren.push(child);
      }
    } else {
      newChildren.push(child);
      walkText(child, [...ancestors, parent], fn);
    }
  }

  if (changed) {
    parent.children = newChildren;
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

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
    const isSigil =
      node.type === "element" &&
      (node as HastElement).properties?.["data-sigil-type"];

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

// ── Plugin ───────────────────────────────────────────────────────────────────

/**
 * Rehype plugin factory. Returns a transformer that replaces sigil tokens
 * in text nodes with <span> elements, coalescing adjacent sigils into groups.
 */
export function rehypeSigils() {
  return (tree: HastRoot) => {
    walkText(tree, [], (textNode, ancestors) => {
      if (hasCodeAncestor(ancestors)) return null;

      const text = textNode.value;
      const matches = parseSigils(text);
      if (matches.length === 0) return null;

      // Build replacement nodes: interleave text segments and sigil elements
      const nodes: HastNode[] = [];
      let cursor = 0;

      for (const match of matches) {
        // Text before this sigil
        if (match.start > cursor) {
          nodes.push({ type: "text", value: text.slice(cursor, match.start) });
        }
        nodes.push(buildSigilSpan(match));
        cursor = match.end;
      }

      // Remaining text after last sigil
      if (cursor < text.length) {
        nodes.push({ type: "text", value: text.slice(cursor) });
      }

      return coalesceNodes(nodes);
    });
  };
}
