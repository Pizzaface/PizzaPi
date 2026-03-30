/** A parsed sigil token from text. */
export interface SigilMatch {
  /** Sigil type name, e.g. "pr", "file", "commit" */
  type: string;
  /** Primary identifier, e.g. "55", "src/auth.ts", "abc123" */
  id: string;
  /** Optional key-value params, e.g. { status: "merged", label: "Add auth" } */
  params: Record<string, string>;
  /** Start offset in the source text (inclusive) */
  start: number;
  /** End offset in the source text (exclusive) */
  end: number;
  /** The original raw text, e.g. '[[pr:55 status=merged]]' */
  raw: string;
}

/** Configuration for rendering a sigil type. */
export interface SigilRenderConfig {
  /** Display label for the type, e.g. "Pull Request" */
  label: string;
  /** Lucide icon name */
  icon?: string;
  /** Tailwind color classes for the pill background */
  colorClass?: string;
  /** URL template — {id} and {param} are replaced. Return undefined to skip linking. */
  href?: (id: string, params: Record<string, string>) => string | undefined;
}
