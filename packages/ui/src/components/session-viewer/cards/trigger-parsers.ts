/**
 * Pure parsing logic for trigger message bodies.
 * Extracted from TriggerCard.tsx so tests can import without JSX dependencies.
 */

/** Structured question from a child AskUserQuestion trigger. */
export interface ParsedTriggerQuestion {
  question: string;
  options: string[];
  type?: "radio" | "checkbox" | "ranked";
}

export interface ParsedTrigger {
  type: "ask_user_question" | "plan_review" | "session_complete" | "session_error" | "escalate" | "unknown";
  childName?: string;
  question?: string;
  options?: string[];
  /** Structured questions array (multi-question, checkbox, ranked support). */
  questions?: ParsedTriggerQuestion[];
  planTitle?: string;
  planSteps?: Array<{ title: string; description?: string }>;
  message?: string;
  reason?: string;
  exitReason?: "completed" | "killed" | "error";
  fullOutputPath?: string;
}

export function parseTriggerBody(body: string): ParsedTrigger {
  // Detect trigger type from content patterns
  // ask_user_question: may or may not have Options line (open-ended questions omit it)
  if (body.includes('" asks:')) {
    return parsAskUserQuestion(body);
  }
  if (body.includes("submitted a plan for review")) {
    return parsePlanReview(body);
  }
  // Anchor session_complete to the first line BEFORE checking for "encountered an error:"
  // because session_complete summaries can contain that phrase in their body text,
  // which would otherwise cause a false positive match for session_error.
  if (/^🔗 Child "[^"]+" (?:completed|was killed|errored):/.test(body)) {
    return parseSessionComplete(body);
  }
  // Anchor session_error to the first line as well, so that summary text embedded
  // in other trigger types (e.g. session_complete) cannot trigger a false match.
  if (/^⚠️ Child "[^"]+" encountered an error:/.test(body)) {
    return parseSessionError(body);
  }
  if (body.includes("Trigger escalated")) {
    return parseEscalateTrigger(body);
  }

  return { type: "unknown" };
}

function parsAskUserQuestion(body: string): ParsedTrigger {
  const childMatch = body.match(/Child "([^"]+)" asks:/);
  const childName = childMatch?.[1];
  const questionMatch = body.match(/> (.+)/);
  const question = questionMatch?.[1];
  const optionsMatch = body.match(/Options: (.+)/);
  const optionsStr = optionsMatch?.[1];
  const options = optionsStr
    ? optionsStr
        .split(/  /)
        .map((opt) => opt.replace(/^\d+\. /, "").trim())
        .filter(Boolean)
    : [];

  // Extract structured questions from embedded JSON comment if present.
  // Format: <!-- questions:[...] -->
  let questions: ParsedTriggerQuestion[] | undefined;
  const jsonMatch = body.match(/<!-- questions:(.*?) -->/);
  if (jsonMatch?.[1]) {
    try {
      // Reverse the "--\>" escape applied by the trigger renderer
      const parsed = JSON.parse(jsonMatch[1].replace(/--\\>/g, "-->"));
      if (Array.isArray(parsed) && parsed.length > 0) {
        questions = parsed
          .filter((q: any) => q && typeof q === "object" && typeof q.question === "string")
          .map((q: any) => ({
            question: q.question,
            options: Array.isArray(q.options) ? q.options.filter((o: any) => typeof o === "string") : [],
            ...(q.type === "checkbox" || q.type === "ranked" ? { type: q.type } : {}),
          }));
        if (questions.length === 0) questions = undefined;
      }
    } catch {
      // Malformed JSON — fall back to legacy parsing
    }
  }

  return { type: "ask_user_question", childName, question, options, questions };
}

function parsePlanReview(body: string): ParsedTrigger {
  const childMatch = body.match(/Child "([^"]+)" submitted/);
  const childName = childMatch?.[1];
  const titleMatch = body.match(/## (.+)/);
  const planTitle = titleMatch?.[1];

  // Strip trailing trigger instructions before parsing steps
  const stepsBody = body.replace(/\n\n(?:Respond with|Use respond_to_trigger)[\s\S]*$/, "");

  // Parse steps (numbered lines)
  const steps: Array<{ title: string; description?: string }> = [];
  const stepRegex = /(\d+)\. (.+?)(?:\n   (.+?))?(?=\n\d+\.|$)/gs;
  let match;
  while ((match = stepRegex.exec(stepsBody))) {
    steps.push({
      title: match[2],
      description: match[3]?.trim(),
    });
  }

  return { type: "plan_review", childName, planTitle, planSteps: steps };
}

function parseSessionComplete(body: string): ParsedTrigger {
  const childMatch = body.match(/Child "([^"]+)" (?:completed|was killed|errored):/);
  const childName = childMatch?.[1];

  // Parse exitReason from "Exit reason: completed|killed|error" line (new format).
  // Fall back to inferring it from the title verb for legacy messages that lack that line.
  const exitReasonMatch = body.match(/Exit reason: (completed|killed|error)/);
  let exitReason: "completed" | "killed" | "error";
  if (exitReasonMatch?.[1]) {
    exitReason = exitReasonMatch[1] as "completed" | "killed" | "error";
  } else if (/^🔗 Child "[^"]+" was killed:/.test(body)) {
    exitReason = "killed";
  } else if (/^🔗 Child "[^"]+" errored:/.test(body)) {
    exitReason = "error";
  } else {
    exitReason = "completed";
  }

  // Summary follows the "---" separator.
  // Stop only at the *specific* footer "📄 Full output saved to:" — not at any arbitrary
  // 📄 that might appear in the child's summary text (e.g. "📄 Generated files:").
  const summaryMatch = body.match(/---\n(.+?)(?=\n\n(?:📄 Full output saved to:|Respond with|Use respond_to_trigger|Acknowledge)|$)/s);
  // Fall back to old format (no "Exit reason:" line)
  const fallbackMatch = !summaryMatch ? body.match(/(?:completed|was killed|errored):\n(.+?)(?=\n\n(?:Respond with|Use respond_to_trigger|Acknowledge)|$)/s) : null;
  const message = (summaryMatch ?? fallbackMatch)?.[1]?.trim();

  // Capture the "📄 Full output saved to: <path>" line if present.
  const fullOutputPathMatch = body.match(/📄 Full output saved to: (.+)/);
  const fullOutputPath = fullOutputPathMatch?.[1]?.trim();

  return { type: "session_complete", childName, message, exitReason, fullOutputPath };
}

function parseSessionError(body: string): ParsedTrigger {
  const childMatch = body.match(/Child "([^"]+)" encountered/);
  const childName = childMatch?.[1];
  const msgMatch = body.match(/error:\n(.+?)(?=\n\nRespond|$)/s);
  const message = msgMatch?.[1]?.trim();

  return { type: "session_error", childName, message };
}

function parseEscalateTrigger(body: string): ParsedTrigger {
  const childMatch = body.match(/from child "([^"]+)"/);
  const childName = childMatch?.[1];
  const reasonMatch = body.match(/escalated from child "[^"]+"[:\s]*\n(.+?)(?=\n\n|$)/s);
  const reason = reasonMatch?.[1]?.trim();

  return { type: "escalate", childName, reason };
}
