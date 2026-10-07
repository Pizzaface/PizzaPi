import { describe, expect, test } from "bun:test";
import { PLUGIN_COMMAND_MESSAGE_TYPE } from "@pizzapi/protocol";
import { groupPluginResults } from "./grouping";
import type { RelayMessage } from "./types";

const plugin = (key: string, n: number): RelayMessage => ({ key, role: "custom", customType: PLUGIN_COMMAND_MESSAGE_TYPE, content: "out", details: { n } });

describe("groupPluginResults", () => {
  test("a run of plugin results collapses into one card with the first key and latest details", () => {
    const out = groupPluginResults([
      { key: "u", role: "user", content: "hi" },
      plugin("a", 1),
      { key: "blank", role: "assistant", content: "" }, // invisible — doesn't break the run
      plugin("b", 2),
      plugin("c", 3),
      { key: "x", role: "assistant", content: "text" },
      plugin("d", 4),
    ]);
    const cards = out.filter((m) => m.customType === PLUGIN_COMMAND_MESSAGE_TYPE);
    expect(cards.map((m) => [m.key, (m.details as { n: number }).n])).toEqual([["a", 3], ["d", 4]]);
  });
});
