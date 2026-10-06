import { describe, expect, test } from "bun:test";
import { parsedTriggerFromStructured } from "./trigger-parsers";

const base = { sourceSessionId: "abcdef0123456789", sourceSessionName: "Fixer" };

describe("parsedTriggerFromStructured", () => {
  test("session_complete reads summary/exitReason/fullOutputPath from payload", () => {
    expect(parsedTriggerFromStructured({
      ...base, type: "lifecycle:session_complete",
      payload: { summary: "Done.\n\n---\nnot a separator", exitReason: "killed", fullOutputPath: "/tmp/o.md" },
    })).toEqual({ type: "session_complete", childName: "Fixer", message: "Done.\n\n---\nnot a separator", exitReason: "killed", fullOutputPath: "/tmp/o.md" });
  });

  test("ask_question normalizes structured questions; falls back to id prefix for name", () => {
    const p = parsedTriggerFromStructured({
      sourceSessionId: "abcdef0123456789", type: "lifecycle:ask_question",
      payload: { question: "Q?", options: ["a", 1, "b"], questions: [{ question: "Pick", options: ["x"], type: "checkbox" }, { bad: true }] },
    });
    expect(p).toEqual({
      type: "ask_user_question", childName: "abcdef01", question: "Q?", options: ["a", "b"],
      questions: [{ question: "Pick", options: ["x"], type: "checkbox" }],
    });
  });

  test("plan_review, session_error, escalation, unknown", () => {
    expect(parsedTriggerFromStructured({ ...base, type: "lifecycle:plan_review", payload: { title: "T", steps: [{ title: "s1", description: "d" }] } }))
      .toEqual({ type: "plan_review", childName: "Fixer", planTitle: "T", planSteps: [{ title: "s1", description: "d" }] });
    expect(parsedTriggerFromStructured({ ...base, type: "lifecycle:session_error", payload: { error: "boom" } }))
      .toEqual({ type: "session_error", childName: "Fixer", message: "boom" });
    expect(parsedTriggerFromStructured({ ...base, type: "lifecycle:escalation", payload: { reason: "help" } }))
      .toEqual({ type: "escalate", childName: "Fixer", reason: "help" });
    expect(parsedTriggerFromStructured({ ...base, type: "github:pr_comment", payload: {} })).toEqual({ type: "unknown" });
  });
});
