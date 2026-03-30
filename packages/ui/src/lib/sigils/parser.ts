import type { SigilMatch } from "./types";

/**
 * Regex to match sigil tokens: [[type:id ...params]]
 *
 * - type: word characters, hyphens
 * - id: everything up to the first space or ]] (must not contain `[`)
 * - params: optional key=value or key="quoted value" pairs
 *
 * Does NOT handle nested brackets — [[foo:[[bar]]]] is invalid.
 */
const SIGIL_RE = /\[\[([a-zA-Z][\w-]*):([^\s\]\[]*)((?:\s+[a-zA-Z][\w-]*=(?:"[^"]*"|[^\s\]"]+))*)\s*\]\]/g;

/**
 * Regex to match individual key=value or key="quoted value" params.
 */
const PARAM_RE = /([a-zA-Z][\w-]*)=(?:"([^"]*)"|([^\s\]]+))/g;

/**
 * Parse key=value params from a param string.
 */
function parseParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!raw) return params;
  let m: RegExpExecArray | null;
  PARAM_RE.lastIndex = 0;
  while ((m = PARAM_RE.exec(raw)) !== null) {
    // m[2] is quoted value, m[3] is unquoted value
    params[m[1]] = m[2] ?? m[3];
  }
  return params;
}

/**
 * Build a set of ranges that are inside code spans or fenced code blocks.
 * Sigils inside these ranges should be skipped.
 */
function buildCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // Fenced code blocks: ``` or ~~~
  const fencedRe = /^(`{3,}|~{3,}).*\n[\s\S]*?\n\1\s*$/gm;
  let m: RegExpExecArray | null;
  fencedRe.lastIndex = 0;
  while ((m = fencedRe.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }

  // Inline code spans: `...` (but not inside fenced blocks)
  const codeSpanRe = /`([^`\n]+)`/g;
  codeSpanRe.lastIndex = 0;
  while ((m = codeSpanRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    // Only add if not already inside a fenced block
    const insideFenced = ranges.some(([fs, fe]) => start >= fs && end <= fe);
    if (!insideFenced) {
      ranges.push([start, end]);
    }
  }

  return ranges;
}

/**
 * Check if a position falls inside any code range.
 */
function isInsideCode(pos: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => pos >= start && pos < end);
}

/**
 * Parse all sigil tokens from a text string.
 * Skips sigils inside code spans and fenced code blocks.
 */
export function parseSigils(text: string): SigilMatch[] {
  if (!text || !text.includes("[[")) return [];

  const codeRanges = buildCodeRanges(text);
  const matches: SigilMatch[] = [];

  SIGIL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SIGIL_RE.exec(text)) !== null) {
    if (isInsideCode(m.index, codeRanges)) continue;

    matches.push({
      type: m[1].toLowerCase(),
      id: m[2],
      params: parseParams(m[3]),
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
    });
  }

  return matches;
}
