/**
 * Pure parsing logic for trigger message bodies.
 * Extracted from TriggerCard.tsx so tests can import without JSX dependencies.
 */

export interface ParsedTrigger {
  type: "ask_user_question" | "plan_review" | "session_complete" | "session_error" | "escalate" | "unknown";
  childName?: string;
  question?: string;
  options?: string[];
  planTitle?: string;
  planSteps?: Array<{ title: string; description?: string }>;
  message?: string;
  reason?: string;
  exitReason?: "completed" | "killed" | "error";
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
  if (body.includes("completed:") || body.includes("was killed:") || body.includes("errored:")) {
    return parseSessionComplete(body);
  }
  if (body.includes("encountered an error:")) {
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

  return { type: "ask_user_question", childName, question, options };
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

  // Parse exitReason from "Exit reason: completed|killed|error" line
  const exitReasonMatch = body.match(/Exit reason: (completed|killed|error)/);
  const exitReason = (exitReasonMatch?.[1] as "completed" | "killed" | "error") ?? "completed";

  // Summary follows the "---" separator
  const summaryMatch = body.match(/---\n(.+?)(?=\n\n(?:📄|Respond with|Use respond_to_trigger|Acknowledge)|$)/s);
  // Fall back to old format (no "Exit reason:" line)
  const fallbackMatch = !summaryMatch ? body.match(/(?:completed|was killed|errored):\n(.+?)(?=\n\n(?:Respond with|Use respond_to_trigger|Acknowledge)|$)/s) : null;
  const message = (summaryMatch ?? fallbackMatch)?.[1]?.trim();

  return { type: "session_complete", childName, message, exitReason };
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
