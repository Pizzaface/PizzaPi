export type ParsedActionSigil =
  | { kind: "confirm"; question: string }
  | { kind: "choose"; question: string; options: string[] }
  | { kind: "input"; question: string; placeholder?: string };

export type ActionParseResult =
  | { ok: true; action: ParsedActionSigil }
  | { ok: false; error: string };

export function parseActionSigil(
  variant: string,
  params: Record<string, string>,
): ActionParseResult {
  const question = params.question?.trim();
  if (!question) return { ok: false, error: "missing_question" };

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
  return raw
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean);
}

export function buildActionResponse(action: ParsedActionSigil, value: string): string {
  return [
    "Action sigil response",
    `variant=${action.kind}`,
    `question=${action.question}`,
    `value=${value}`,
  ].join("\n");
}
