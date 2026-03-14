import { describe, test, expect } from "bun:test";

// Helper function extracted for testing (same as in TriggerCard.tsx)
function parseTriggerBody(body: string): {
  type: "ask_user_question" | "plan_review" | "session_complete" | "session_error" | "escalate" | "unknown";
  childName?: string;
  question?: string;
  options?: string[];
  planTitle?: string;
  planSteps?: Array<{ title: string; description?: string }>;
  message?: string;
  reason?: string;
} {
  // Detect trigger type from content patterns
  if (body.includes("asks:") && body.includes("Options:")) {
    return parsAskUserQuestion(body);
  }
  if (body.includes("submitted a plan for review")) {
    return parsePlanReview(body);
  }
  if (body.includes("completed:")) {
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

function parsAskUserQuestion(body: string): ReturnType<typeof parseTriggerBody> {
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

function parsePlanReview(body: string): ReturnType<typeof parseTriggerBody> {
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

function parseSessionComplete(body: string): ReturnType<typeof parseTriggerBody> {
  const childMatch = body.match(/Child "([^"]+)" completed:/);
  const childName = childMatch?.[1];
  // Everything after "completed:\n" up to the first blank line or respond_to_trigger instruction
  const summaryMatch = body.match(/completed:\n(.+?)(?=\n\n(?:Respond with|Use respond_to_trigger|Acknowledge)|$)/s);
  const message = summaryMatch?.[1]?.trim();

  return { type: "session_complete", childName, message };
}

function parseSessionError(body: string): ReturnType<typeof parseTriggerBody> {
  const childMatch = body.match(/Child "([^"]+)" encountered/);
  const childName = childMatch?.[1];
  const msgMatch = body.match(/error:\n(.+?)(?=\n\nRespond|$)/s);
  const message = msgMatch?.[1]?.trim();

  return { type: "session_error", childName, message };
}

function parseEscalateTrigger(body: string): ReturnType<typeof parseTriggerBody> {
  const childMatch = body.match(/from child "([^"]+)"/);
  const childName = childMatch?.[1];
  const reasonMatch = body.match(/escalated from child "[^"]*":\n(.+?)(?=\n|$)/s);
  const reason = reasonMatch?.[1]?.trim();

  return { type: "escalate", childName, reason };
}

describe("TriggerCard trigger parsing", () => {
  describe("parseTriggerBody", () => {
    test("detects ask_user_question trigger type", () => {
      const body = `🔗 Child "test-child" asks:
> What is your name?
Options: 1. Alice  2. Bob  3. Charlie

Respond with \`respond_to_trigger\` using trigger ID \`abc123\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("ask_user_question");
      expect(parsed.childName).toBe("test-child");
      expect(parsed.question).toBe("What is your name?");
      expect(parsed.options).toContain("Alice");
      expect(parsed.options).toContain("Bob");
    });

    test("detects plan_review trigger type", () => {
      const body = `🔗 Child "planner" submitted a plan for review:
## Fix Login System

1. Add password validation
   Check password strength requirements
2. Add rate limiting
   Implement exponential backoff`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("plan_review");
      expect(parsed.childName).toBe("planner");
      expect(parsed.planTitle).toBe("Fix Login System");
      expect(parsed.planSteps).toHaveLength(2);
      expect(parsed.planSteps?.[0].title).toBe("Add password validation");
      expect(parsed.planSteps?.[0].description).toBe("Check password strength requirements");
    });

    test("detects session_complete trigger type", () => {
      const body = `🔗 Child "test-task" completed:
All tests passed successfully. 5 files modified.

Respond with \`respond_to_trigger\` using trigger ID \`xyz789\`.
Use respond_to_trigger with action: "ack" to acknowledge, or action: "followUp" with instructions to resume the child.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_complete");
      expect(parsed.childName).toBe("test-task");
      expect(parsed.message).toBe("All tests passed successfully. 5 files modified.");
    });

    test("detects session_error trigger type", () => {
      const body = `⚠️ Child "failed-task" encountered an error:
Command execution failed: file not found

Respond with \`respond_to_trigger\` using trigger ID \`err123\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_error");
      expect(parsed.childName).toBe("failed-task");
      expect(parsed.message).toBe("Command execution failed: file not found");
    });

    test("detects escalate trigger type", () => {
      const body = `🚨 Trigger escalated from child "needs-approval":
This requires special permission to proceed.

This requires human attention. Respond with \`respond_to_trigger\` using trigger ID \`esc456\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("escalate");
      expect(parsed.childName).toBe("needs-approval");
      // Reason is after the colon and the name line
      expect(parsed.reason?.includes("special permission")).toBe(true);
    });

    test("returns unknown type for unrecognized content", () => {
      const body = "Some random content";
      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("unknown");
    });

    test("handles ask_user_question without options", () => {
      const body = `🔗 Child "questioner" asks:
> Simple yes/no question?
Options: 

Respond with \`respond_to_trigger\` using trigger ID \`q123\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("ask_user_question");
      expect(parsed.question).toBe("Simple yes/no question?");
    });

    test("handles plan_review with description field", () => {
      const body = `🔗 Child "planner" submitted a plan for review:
## Refactor Database

Consolidate three databases into one for easier management.

1. Backup existing data
   Create snapshots of all three databases
2. Migrate data
   Transfer records to new unified schema`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("plan_review");
      expect(parsed.planTitle).toBe("Refactor Database");
      expect(parsed.planSteps).toHaveLength(2);
    });

    test("plan_review strips trailing trigger instructions from steps", () => {
      const body = `🔗 Child "planner" submitted a plan for review:
## Deploy Service

1. Build Docker image
   Run docker build with production config
2. Push to registry

Respond with \`respond_to_trigger\` using trigger ID \`plan123\`.
Use respond_to_trigger with action: "approve" to accept, "cancel" to reject, or "edit" with feedback.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("plan_review");
      expect(parsed.planSteps).toHaveLength(2);
      expect(parsed.planSteps?.[1].title).toBe("Push to registry");
      // Ensure instructions are NOT absorbed into last step
      expect(parsed.planSteps?.[1].description).toBeUndefined();
    });
  });
});
