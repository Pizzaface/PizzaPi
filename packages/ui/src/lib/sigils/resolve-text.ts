import { parseSigils } from "./parser";
import type { SigilMatch } from "./types";

/** Resolve one sigil to the plain text an external system should receive. */
export type SigilTextResolver = (match: SigilMatch) => string | undefined | Promise<string | undefined>;

/**
 * Replace resolvable sigils in text while leaving unresolved tokens unchanged.
 * Code spans and fenced code blocks are left alone by parseSigils.
 */
export async function resolveSigilsToText(
  text: string,
  resolve: SigilTextResolver,
): Promise<string> {
  const matches = parseSigils(text);
  if (matches.length === 0) return text;

  const replacements = await Promise.all(matches.map(async (match) => {
    try {
      return (await resolve(match)) || match.raw;
    } catch {
      return match.raw;
    }
  }));

  let result = "";
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    result += text.slice(cursor, match.start) + replacements[i];
    cursor = match.end;
  }
  return result + text.slice(cursor);
}
