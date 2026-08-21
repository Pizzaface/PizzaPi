export type ParsedActionSigil =
  | { kind: "confirm"; question?: string }
  | { kind: "choose"; question?: string; options: string[] }
  | { kind: "input"; question?: string; placeholder?: string };

export type ActionParseResult =
  | { ok: true; action: ParsedActionSigil }
  | { ok: false; error: string };

export function parseActionSigil(
  variant: string,
  params: Record<string, string>,
): ActionParseResult {
  const question = params.question?.trim() || undefined;

  switch (variant) {
    case "confirm":
      return { ok: true, action: { kind: "confirm", question } };
    case "choose": {
      const options = parseActionOptions(params.options);
      if (options.length === 0) return { ok: false, error: "missing_options" };
      return { ok: true, action: { kind: "choose", question, options } };
    }
    case "input": {
      const placeholder = params.placeholder?.trim();
      return {
        ok: true,
        action: { kind: "input", question, ...(placeholder ? { placeholder } : {}) },
      };
    }
    default:
      return { ok: false, error: "unknown_variant" };
  }
}

export function parseActionOptions(raw?: string): string[] {
  if (!raw) return [];
  // Support both comma-separated and pipe-separated option lists so LLM-generated
  // sigils like options="a|b|c" render correctly alongside the documented
  // comma form.
  const separator = raw.includes("|") ? "|" : ",";
  // ponytail: comma splitting ignores commas nested in (), [] or {} so labels
  // like "Security lane only (B-, 17 dishes)" survive. Pipes need no nesting.
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (separator === "," && (ch === "(" || ch === "[" || ch === "{")) depth++;
    else if (separator === "," && (ch === ")" || ch === "]" || ch === "}")) depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((option) => option.trim()).filter(Boolean);
}

export function buildActionResponse(action: ParsedActionSigil, value: string): string {
  return [
    "Action sigil response",
    `variant=${action.kind}`,
    `question=${action.question ?? ""}`,
    `value=${value}`,
  ].join("\n");
}
