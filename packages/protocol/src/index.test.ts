import { describe, expect, test } from "bun:test";
import {
  PASSWORD_REQUIREMENTS,
  PASSWORD_REQUIREMENTS_SUMMARY,
  validatePassword,
  isValidPassword,
} from "./index";
import type {
  Attachment,
  HubClientToServerEvents,
  HubInterServerEvents,
  HubServerToClientEvents,
  HubSocketData,
  ModelInfo,
  PasswordCheck,
  PasswordCheckItem,
  RelayClientToServerEvents,
  RelayInterServerEvents,
  RelayServerToClientEvents,
  RelaySocketData,
  RunnerAgent,
  RunnerClientToServerEvents,
  RunnerHook,
  RunnerInfo,
  RunnerInterServerEvents,
  RunnerPlugin,
  RunnerServerToClientEvents,
  RunnerSkill,
  RunnerSocketData,
  SessionInfo,
  TerminalClientToServerEvents,
  TerminalInterServerEvents,
  TerminalServerToClientEvents,
  TerminalSocketData,
  ViewerClientToServerEvents,
  ViewerInterServerEvents,
  ViewerServerToClientEvents,
  ViewerSocketData,
} from "./index";

// ---------------------------------------------------------------------------
// index.ts public API surface - verify all runtime exports are present
// ---------------------------------------------------------------------------

import { MAX_PASSWORD_LENGTH } from "./index";

describe("index - runtime exports", () => {
  test("MAX_PASSWORD_LENGTH is exported correctly", () => {
    expect(MAX_PASSWORD_LENGTH).toBe(128);
  });

  test("PASSWORD_REQUIREMENTS is exported and is a readonly tuple of 5 strings", () => {
    expect(Array.isArray(PASSWORD_REQUIREMENTS)).toBe(true);
    expect(PASSWORD_REQUIREMENTS).toHaveLength(5);
    for (const req of PASSWORD_REQUIREMENTS) {
      expect(typeof req).toBe("string");
      expect(req.length).toBeGreaterThan(0);
    }
  });

  test("PASSWORD_REQUIREMENTS covers length, uppercase, lowercase, number", () => {
    const joined = PASSWORD_REQUIREMENTS.join(" ").toLowerCase();
    expect(joined).toContain("8");
    expect(joined).toContain("uppercase");
    expect(joined).toContain("lowercase");
    expect(joined).toContain("number");
  });

  test("PASSWORD_REQUIREMENTS_SUMMARY is a non-empty string", () => {
    expect(typeof PASSWORD_REQUIREMENTS_SUMMARY).toBe("string");
    expect(PASSWORD_REQUIREMENTS_SUMMARY.length).toBeGreaterThan(0);
  });

  test("PASSWORD_REQUIREMENTS_SUMMARY mentions key requirements", () => {
    const lower = PASSWORD_REQUIREMENTS_SUMMARY.toLowerCase();
    expect(lower).toContain("8");
    expect(lower).toContain("uppercase");
    expect(lower).toContain("lowercase");
    expect(lower).toContain("number");
  });

  test("validatePassword is a function", () => {
    expect(typeof validatePassword).toBe("function");
  });

  test("isValidPassword is a function", () => {
    expect(typeof isValidPassword).toBe("function");
  });

  test("validatePassword returns the expected PasswordCheck shape", () => {
    const result = validatePassword("Valid1Pass");
    expect(typeof result.valid).toBe("boolean");
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checks).toHaveLength(5);
    for (const check of result.checks) {
      expect(typeof check.label).toBe("string");
      expect(typeof check.met).toBe("boolean");
    }
  });

  test("isValidPassword returns boolean", () => {
    expect(typeof isValidPassword("Valid1Pass")).toBe("boolean");
    expect(typeof isValidPassword("bad")).toBe("boolean");
  });

  test("isValidPassword and validatePassword are consistent", () => {
    const passwords = ["Valid1Pass", "short", "NOLOWER1", "noupper1", "NoNumbers", ""];
    for (const pw of passwords) {
      expect(isValidPassword(pw)).toBe(validatePassword(pw).valid);
    }
  });
});

// ---------------------------------------------------------------------------
// index.ts public API surface — verify type-only exports are present (compile-time)
// ---------------------------------------------------------------------------

describe("index — type exports", () => {
  test(
    "re-exports type-only symbols expected by external consumers (compile-time)",
    () => {
      // Runtime value is irrelevant; the assertion is enforced by TypeScript during
      // `bun run typecheck` (packages/protocol typecheck:tests).
      const _types = null as unknown as {
        sessionInfo: SessionInfo;
        modelInfo: ModelInfo;
        runnerInfo: RunnerInfo;
        runnerSkill: RunnerSkill;
        runnerAgent: RunnerAgent;
        runnerPlugin: RunnerPlugin;
        runnerHook: RunnerHook;
        attachment: Attachment;

        passwordCheck: PasswordCheck;
        passwordCheckItem: PasswordCheckItem;

        relayC2S: RelayClientToServerEvents;
        relayS2C: RelayServerToClientEvents;
        relayInter: RelayInterServerEvents;
        relaySocket: RelaySocketData;

        viewerC2S: ViewerClientToServerEvents;
        viewerS2C: ViewerServerToClientEvents;
        viewerInter: ViewerInterServerEvents;
        viewerSocket: ViewerSocketData;

        runnerC2S: RunnerClientToServerEvents;
        runnerS2C: RunnerServerToClientEvents;
        runnerInter: RunnerInterServerEvents;
        runnerSocket: RunnerSocketData;

        terminalC2S: TerminalClientToServerEvents;
        terminalS2C: TerminalServerToClientEvents;
        terminalInter: TerminalInterServerEvents;
        terminalSocket: TerminalSocketData;

        hubC2S: HubClientToServerEvents;
        hubS2C: HubServerToClientEvents;
        hubInter: HubInterServerEvents;
        hubSocket: HubSocketData;
      };

      expect(_types).toBeNull();
    },
  );
});
