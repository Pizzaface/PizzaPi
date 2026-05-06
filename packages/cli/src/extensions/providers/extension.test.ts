import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, test, expect } from "bun:test";

describe("provider extension", () => {
  test("extension module exports a default function", async () => {
    const mod = await import("./extension");
    expect(typeof mod.default).toBe("function");
  });

  test("extension registers on session_start, before_agent_start, turn_end, session_shutdown", async () => {
    const events: string[] = [];
    const mockPi = {
      on: (event: string) => { events.push(event); },
      registerCommand: () => {},
    } as unknown as ExtensionAPI;

    const ext = await import("./extension");
    await ext.default(mockPi);

    expect(events).toContain("session_start");
    expect(events).toContain("before_agent_start");
    expect(events).toContain("turn_end");
    expect(events).toContain("session_shutdown");
  });
});
