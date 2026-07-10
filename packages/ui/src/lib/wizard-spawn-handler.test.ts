import { describe, expect, test } from "bun:test";
import { createWizardSpawnHandler } from "./wizard-spawn-handler";

describe("createWizardSpawnHandler", () => {
  test("closes wizard only after successful spawn and open", async () => {
    const calls: string[] = [];

    const handler = createWizardSpawnHandler({
      spawnSession: async (runnerId: string, cwd: string | undefined) => {
        calls.push(`spawn:${runnerId}:${cwd}`);
        return "session-abc";
      },
      openSession: (sessionId: string) => {
        calls.push(`open:${sessionId}`);
      },
      setOpen: (open: boolean) => {
        calls.push(`setOpen:${open}`);
      },
    });

    await handler("runner-1", "/tmp/foo");

    expect(calls).toEqual(["spawn:runner-1:/tmp/foo", "open:session-abc", "setOpen:false"]);
  });

  test("leaves wizard open when spawn fails", async () => {
    const spawnError = new Error("spawn failed");

    const handler = createWizardSpawnHandler({
      spawnSession: async () => {
        throw spawnError;
      },
      openSession: () => {
        throw new Error("openSession should not be called on spawn failure");
      },
      setOpen: () => {
        throw new Error("setOpen should not be called on spawn failure");
      },
    });

    await expect(handler("runner-1", undefined)).rejects.toBe(spawnError);
  });
});
