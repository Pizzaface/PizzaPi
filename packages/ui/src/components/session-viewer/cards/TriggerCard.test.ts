import { describe, test, expect } from "bun:test";
import { parseTriggerBody } from "./trigger-parsers";

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
Exit reason: completed
---
All tests passed successfully. 5 files modified.

Respond with \`respond_to_trigger\` using trigger ID \`xyz789\`.
Use respond_to_trigger with action: "ack" to acknowledge, or action: "followUp" with instructions to resume the child.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_complete");
      expect(parsed.childName).toBe("test-task");
      expect(parsed.message).toBe("All tests passed successfully. 5 files modified.");
      expect(parsed.exitReason).toBe("completed");
    });

    test("detects killed session_complete trigger", () => {
      const body = `🔗 Child "test-task" was killed:
Exit reason: killed
---
Session completed

Respond with \`respond_to_trigger\` using trigger ID \`xyz789\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_complete");
      expect(parsed.childName).toBe("test-task");
      expect(parsed.exitReason).toBe("killed");
    });

    test("detects errored session_complete trigger", () => {
      const body = `🔗 Child "test-task" errored:
Exit reason: error
---
Something went wrong

Respond with \`respond_to_trigger\` using trigger ID \`xyz789\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_complete");
      expect(parsed.childName).toBe("test-task");
      expect(parsed.exitReason).toBe("error");
    });

    test("handles legacy session_complete format without exitReason", () => {
      const body = `🔗 Child "test-task" completed:
All tests passed successfully.

Respond with \`respond_to_trigger\` using trigger ID \`xyz789\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_complete");
      expect(parsed.childName).toBe("test-task");
      expect(parsed.exitReason).toBe("completed");
      expect(parsed.message).toBe("All tests passed successfully.");
    });

    test("handles legacy session_complete format with 'was killed:' title — exitReason is killed", () => {
      // Legacy format: no "Exit reason:" line, verb in title must be used to infer exitReason.
      const body = `🔗 Child "test-task" was killed:
Session terminated by user.

Respond with \`respond_to_trigger\` using trigger ID \`xyz789\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_complete");
      expect(parsed.childName).toBe("test-task");
      expect(parsed.exitReason).toBe("killed");
    });

    test("handles legacy session_complete format with 'errored:' title — exitReason is error", () => {
      const body = `🔗 Child "test-task" errored:
Build failed with exit code 1.

Respond with \`respond_to_trigger\` using trigger ID \`xyz789\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_complete");
      expect(parsed.childName).toBe("test-task");
      expect(parsed.exitReason).toBe("error");
    });

    test("legacy session_complete with 'completed' title is not mis-inferred as killed when summary mentions another killed child", () => {
      // Summary text mentioning another child being killed must not affect the exitReason
      // of the outer (completed) trigger.
      const body = `🔗 Child "main" completed:
Process finished. Child "worker" was killed: by system.

Respond with \`respond_to_trigger\` using trigger ID \`xyz789\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_complete");
      expect(parsed.exitReason).toBe("completed");
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

    test("session_complete whose summary mentions 'encountered an error:' is NOT mis-routed to session_error", () => {
      // A child can include a phrase like "the previous attempt encountered an error: ..."
      // in its completion summary. parseTriggerBody must still return session_complete.
      const body = `🔗 Child "fixer-task" completed:
Exit reason: completed
---
The previous attempt encountered an error: file not found, but it is now fixed.

Respond with \`respond_to_trigger\` using trigger ID \`fix123\`.
Use respond_to_trigger with action: "ack" to acknowledge completion.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_complete");
      expect(parsed.childName).toBe("fixer-task");
      expect(parsed.exitReason).toBe("completed");
      expect(parsed.message).toContain("encountered an error");
    });

    test("session_error with 'errored:' in error message is NOT mis-routed to session_complete", () => {
      // If a session_error message body contains "errored:" or "was killed:", it must
      // still be parsed as session_error, not session_complete.
      const body = `⚠️ Child "build-task" encountered an error:
Build errored: exit code 1

Respond with \`respond_to_trigger\` using trigger ID \`err456\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_error");
      expect(parsed.childName).toBe("build-task");
      expect(parsed.message).toContain("Build errored: exit code 1");
    });

    test("session_error with 'was killed:' in error message is NOT mis-routed to session_complete", () => {
      const body = `⚠️ Child "deploy-task" encountered an error:
Process was killed: signal SIGTERM

Respond with \`respond_to_trigger\` using trigger ID \`err789\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_error");
    });

    test("session_complete summary containing '📄 Generated files:' is NOT truncated at the emoji", () => {
      // The summary regex must stop only at the specific '📄 Full output saved to:' footer,
      // not at arbitrary 📄 lines that appear in the child's summary text.
      const body = `🔗 Child "builder" completed:
Exit reason: completed
---
Build succeeded.

📄 Generated files:
- dist/index.js
- dist/index.css

Respond with \`respond_to_trigger\` using trigger ID \`build123\`.
Use respond_to_trigger with action: "ack" to acknowledge completion.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_complete");
      expect(parsed.message).toContain("📄 Generated files:");
      expect(parsed.message).toContain("dist/index.js");
      expect(parsed.fullOutputPath).toBeUndefined();
    });

    test("session_complete with fullOutputPath is parsed and returned", () => {
      const body = `🔗 Child "long-task" completed:
Exit reason: completed
---
Analysis finished. 42 files processed.

📄 Full output saved to: /tmp/session-abc123/output.txt
(Use the Read tool to access the complete output if the above is insufficient.)

Respond with \`respond_to_trigger\` using trigger ID \`comp999\`.
Use respond_to_trigger with action: "ack" to acknowledge completion.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_complete");
      expect(parsed.message).toBe("Analysis finished. 42 files processed.");
      expect(parsed.fullOutputPath).toBe("/tmp/session-abc123/output.txt");
    });

    test("session_complete without fullOutputPath has undefined fullOutputPath", () => {
      const body = `🔗 Child "short-task" completed:
Exit reason: completed
---
Done.

Respond with \`respond_to_trigger\` using trigger ID \`comp000\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("session_complete");
      expect(parsed.fullOutputPath).toBeUndefined();
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

    // ── Structured questions (rich trigger format) ────────────────────────

    test("parses base64-encoded structured questions from trigger body", () => {
      const questions = [
        { question: "Pick a color", options: ["Red", "Blue"], type: "radio" },
        { question: "Select features", options: ["Auth", "API", "UI"], type: "checkbox" },
      ];
      const encoded = btoa(JSON.stringify(questions));
      const body = `🔗 Child "rich-child" asks:
<!-- questions64:${encoded} -->
> Pick a color; Select features
Options: 1. Red  2. Blue  3. Auth  4. API  5. UI

Respond with \`respond_to_trigger\` using trigger ID \`rich123\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("ask_user_question");
      expect(parsed.childName).toBe("rich-child");
      expect(parsed.questions).toHaveLength(2);
      expect(parsed.questions![0].question).toBe("Pick a color");
      expect(parsed.questions![0].options).toEqual(["Red", "Blue"]);
      expect(parsed.questions![1].question).toBe("Select features");
      expect(parsed.questions![1].type).toBe("checkbox");
      expect(parsed.questions![1].options).toEqual(["Auth", "API", "UI"]);
      // Legacy fields still populated for backward compat
      expect(parsed.options).toContain("Red");
    });

    test("parses ranked question type from base64-encoded JSON", () => {
      const questions = [
        { question: "Prioritize tasks", options: ["Fix bug", "Add feature", "Write docs"], type: "ranked" },
      ];
      const encoded = btoa(JSON.stringify(questions));
      const body = `🔗 Child "ranker" asks:
<!-- questions64:${encoded} -->
> Prioritize tasks
Options: 1. Fix bug  2. Add feature  3. Write docs

Respond with \`respond_to_trigger\` using trigger ID \`rank123\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("ask_user_question");
      expect(parsed.questions).toHaveLength(1);
      expect(parsed.questions![0].type).toBe("ranked");
    });

    test("parses legacy raw JSON questions format (backward compat)", () => {
      const questions = [
        { question: "Pick a color", options: ["Red", "Blue"], type: "radio" },
      ];
      const body = `🔗 Child "legacy-rich" asks:
<!-- questions:${JSON.stringify(questions)} -->
> Pick a color
Options: 1. Red  2. Blue

Respond with \`respond_to_trigger\` using trigger ID \`legrich123\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("ask_user_question");
      expect(parsed.questions).toHaveLength(1);
      expect(parsed.questions![0].question).toBe("Pick a color");
    });

    test("falls back to legacy parsing when embedded JSON is absent", () => {
      const body = `🔗 Child "legacy-child" asks:
> What do you prefer?
Options: 1. Option A  2. Option B

Respond with \`respond_to_trigger\` using trigger ID \`leg123\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("ask_user_question");
      expect(parsed.questions).toBeUndefined();
      expect(parsed.options).toEqual(["Option A", "Option B"]);
    });

    test("falls back gracefully when embedded JSON is malformed", () => {
      const body = `🔗 Child "broken-child" asks:
<!-- questions:{invalid json} -->
> What?
Options: 1. Yes  2. No

Respond with \`respond_to_trigger\` using trigger ID \`brk123\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("ask_user_question");
      expect(parsed.questions).toBeUndefined();
      expect(parsed.options).toEqual(["Yes", "No"]);
    });

    test("legacy format: unescapes __DASH__ sequences in embedded JSON questions", () => {
      // Legacy format used __DASH__ escaping for "--" sequences.
      const raw = `[{"question":"Use --> in code?","options":["Yes","No"]}]`;
      const escaped = raw.replace(/--/g, "__DASH__");
      const body = `🔗 Child "escape-child" asks:
<!-- questions:${escaped} -->
> Use --> in code?
Options: 1. Yes  2. No

Respond with \`respond_to_trigger\` using trigger ID \`esc123\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("ask_user_question");
      expect(parsed.questions).toHaveLength(1);
      expect(parsed.questions![0].question).toBe("Use --> in code?");
      expect(parsed.questions![0].options).toEqual(["Yes", "No"]);
    });

    test("base64 format handles special characters like --> without issues", () => {
      const questions = [{ question: "Use --> in code?", options: ["Yes", "No"] }];
      const encoded = btoa(JSON.stringify(questions));
      const body = `🔗 Child "b64-child" asks:
<!-- questions64:${encoded} -->
> Use --> in code?
Options: 1. Yes  2. No

Respond with \`respond_to_trigger\` using trigger ID \`b64123\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.type).toBe("ask_user_question");
      expect(parsed.questions).toHaveLength(1);
      expect(parsed.questions![0].question).toBe("Use --> in code?");
    });

    test("ignores questions with missing question field in embedded JSON", () => {
      const questions = [
        { question: "Valid?", options: ["Yes"] },
        { options: ["orphan"] },  // missing question field
      ];
      const encoded = btoa(JSON.stringify(questions));
      const body = `🔗 Child "filter-child" asks:
<!-- questions64:${encoded} -->
> Valid?
Options: 1. Yes

Respond with \`respond_to_trigger\` using trigger ID \`flt123\`.`;

      const parsed = parseTriggerBody(body);
      expect(parsed.questions).toHaveLength(1);
      expect(parsed.questions![0].question).toBe("Valid?");
    });
  });
});
